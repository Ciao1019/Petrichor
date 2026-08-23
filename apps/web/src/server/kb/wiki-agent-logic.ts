import { createHash } from "node:crypto"
import { and, asc, count, desc, eq, inArray, isNull, like, or } from "drizzle-orm"
import { z } from "zod"
import { callChatCompletion } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { normalizeS4ObjectKey, normalizeS4ObjectUrl } from "@/lib/s4-url"
import {
    knowledgeBaseAgentArtifacts,
    knowledgeBaseAgentMessages,
    knowledgeBaseAgentRuns,
    knowledgeBaseAgentSteps,
    knowledgeBaseAgentThreads,
    knowledgeBaseArticleChunkIndexes,
    knowledgeBaseArticleChunks,
    knowledgeBaseArticles,
    knowledgeBaseNodes,
    knowledgeBases,
    knowledgeBaseWikiEventLogs,
    knowledgeBaseWikiLinks,
    knowledgeBaseWikiPages,
    knowledgeBaseWikiPatches,
    knowledgeBaseWikiSourceRefs,
    knowledgeBaseWikiTreeNodes,
    type KnowledgeBaseAgentArtifactRecord,
    type KnowledgeBaseAgentThreadRecord,
    type KnowledgeBaseArticleRecord,
    type KnowledgeBaseWikiPageRecord,
    type KnowledgeBaseWikiPatchRecord,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { scoreSearchFields } from "@/server/kb/search-terms"
import {
    buildArticleTree,
    embedKnowledgeBaseTreeNodesBestEffort,
} from "@/server/kb/wiki-tree"
import {
    ARTICLE_KNOWLEDGE_BUILD_VERSION,
    CHUNK_ALGORITHM_VERSION,
    runArticleKnowledgeBuildWorkflow,
    type ExtractedKnowledgeItem,
    type ExtractedKnowledgeRelation,
    type KnowledgeBuildWorkflowResult,
} from "@/server/kb/knowledge-build-workflow"
import {
    buildArticleKnowledgeIndexValues,
    embedKnowledgeBaseArticleIndexBestEffort,
    getKnowledgeBaseArticleIndexStatus,
} from "@/server/kb/article-knowledge-index"

type Db = ReturnType<typeof getDb>
type DbExecutor = Pick<Db, "delete" | "insert" | "select" | "update">

export type ArticleWikiDeletionTarget = {
    id: number
    knowledgeBaseId: number
}

export type WikiPageKind = "index" | "source" | "concept" | "entity" | "comparison" | "answer" | "log"
export type WikiPatchStatus = "PENDING" | "APPLIED" | "REJECTED"

/** 完全重建时清空的 Wiki 数据量，用于回显给调用方。 */
export type WikiPurgeSummary = {
    pageCount: number
    linkCount: number
    sourceRefCount: number
    treeNodeCount: number
}

export type AgentMediaKind = "image" | "video" | "audio" | "file"

export type AgentImageReference = {
    id: string
    kind: AgentMediaKind
    alt: string
    src: string
    objectKey: string | null
    filename: string
    sourceArticleId?: string
    sourceArticleTitle?: string
}

export const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

export const knowledgeBaseIdInputSchema = z.object({
    knowledgeBaseId: idSchema,
})

export const optionalKnowledgeBaseIdInputSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
})

export const wikiIngestInputSchema = knowledgeBaseIdInputSchema.extend({
    articleIds: z.array(idSchema).optional(),
    forceRebuild: z.boolean().optional().default(false),
    // 完全重建：清空该知识库下已有的 Wiki 页面/目录树后再从零编译
    fullRebuild: z.boolean().optional().default(false),
})

export const articleKnowledgeBuildInputSchema = knowledgeBaseIdInputSchema.extend({
    articleId: idSchema,
    forceRebuild: z.boolean().optional().default(false),
})

export const articleKnowledgeChunkListInputSchema = knowledgeBaseIdInputSchema.extend({
    articleId: idSchema,
})

export const wikiPageDetailInputSchema = knowledgeBaseIdInputSchema.extend({
    pageKey: z.string().trim().min(1).max(200),
})

export const wikiTreeInputSchema = knowledgeBaseIdInputSchema.extend({
    articleId: idSchema.optional(),
})

export const wikiPatchDecisionInputSchema = knowledgeBaseIdInputSchema.extend({
    patchId: idSchema,
})

export const agentThreadInputSchema = knowledgeBaseIdInputSchema.extend({
    threadId: idSchema.optional(),
})

export const qaThreadDetailInputSchema = z.object({
    threadId: idSchema,
})

export const qaThreadDeleteInputSchema = z.object({
    threadId: idSchema,
})

export const qaThreadDeleteManyInputSchema = z.object({
    threadIds: z.array(idSchema).min(1).max(200),
})

export const qaThreadListInputSchema = z.object({
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(100).optional(),
    q: z.string().trim().max(120).optional(),
    scope: z.string().optional(),
})

export const agentThreadCreateInputSchema = knowledgeBaseIdInputSchema.extend({
    title: z.string().trim().max(120).optional(),
})

export const qaThreadCreateInputSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    title: z.string().trim().max(120).optional(),
})

export const agentArtifactCreateInputSchema = knowledgeBaseIdInputSchema.extend({
    threadId: idSchema,
    runId: idSchema.optional(),
    artifactType: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().optional().nullable(),
    payload: z.unknown().optional(),
})

const llmArticleWikiSchema = z.object({
    summary: z.string().optional(),
    keyPoints: z.array(z.string()).optional(),
    entities: z.array(z.string()).optional(),
    questions: z.array(z.string()).optional(),
})

interface ArticleWikiDraft {
    summary: string
    keyPoints: string[]
    entities: string[]
    questions: string[]
}

export function formatDate(value: Date | string | null | undefined): string | null {
    if (!value) return null
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function stableHash(value: string) {
    return createHash("sha256").update(value).digest("hex")
}

export function normalizePageKey(input: string) {
    const key = input
        .trim()
        .toLowerCase()
        .replace(/[\s/\\#?&=]+/g, "-")
        .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")

    return key || `page-${stableHash(input).slice(0, 12)}`
}

export function toWikiPageResponse(page: KnowledgeBaseWikiPageRecord) {
    const metadata = readKnowledgePageMetadata(page.frontmatterJson)
    return {
        id: String(page.id),
        knowledgeBaseId: String(page.knowledgeBaseId),
        pageKey: page.pageKey,
        title: page.title,
        kind: page.kind as WikiPageKind,
        contentMd: page.contentMd,
        frontmatter: parseJsonObject(page.frontmatterJson),
        categoryPath: metadata.categoryPath,
        aliases: metadata.aliases,
        summary: page.summary,
        contentHash: page.contentHash,
        version: page.version,
        archivedAt: formatDate(page.archivedAt),
        createdAt: formatDate(page.createdAt),
        updatedAt: formatDate(page.updatedAt),
    }
}

export function toWikiPatchResponse(patch: KnowledgeBaseWikiPatchRecord) {
    return {
        id: String(patch.id),
        knowledgeBaseId: String(patch.knowledgeBaseId),
        threadId: patch.threadId == null ? null : String(patch.threadId),
        runId: patch.runId == null ? null : String(patch.runId),
        pageKey: patch.pageKey,
        title: patch.title,
        operation: patch.operation,
        status: patch.status as WikiPatchStatus,
        beforeContentMd: patch.beforeContentMd,
        proposedContentMd: patch.proposedContentMd,
        diffText: patch.diffText,
        reason: patch.reason,
        appliedAt: formatDate(patch.appliedAt),
        createdAt: formatDate(patch.createdAt),
        updatedAt: formatDate(patch.updatedAt),
    }
}

export function toAgentThreadResponse(thread: KnowledgeBaseAgentThreadRecord, knowledgeBaseName?: string | null) {
    return {
        id: String(thread.id),
        knowledgeBaseId: thread.knowledgeBaseId == null ? null : String(thread.knowledgeBaseId),
        knowledgeBaseName: knowledgeBaseName ?? null,
        title: thread.title,
        status: thread.status,
        lastMessageAt: formatDate(thread.lastMessageAt),
        metadata: parseJsonObject(thread.metadataJson),
        createdAt: formatDate(thread.createdAt),
        updatedAt: formatDate(thread.updatedAt),
    }
}

export function toAgentArtifactResponse(artifact: KnowledgeBaseAgentArtifactRecord) {
    return {
        id: String(artifact.id),
        threadId: String(artifact.threadId),
        runId: artifact.runId == null ? null : String(artifact.runId),
        knowledgeBaseId: artifact.knowledgeBaseId == null ? null : String(artifact.knowledgeBaseId),
        artifactType: artifact.artifactType,
        title: artifact.title,
        payload: parseJsonObject(artifact.payloadJson),
        contentMd: artifact.contentMd,
        createdAt: formatDate(artifact.createdAt),
        updatedAt: formatDate(artifact.updatedAt),
    }
}

export async function assertKnowledgeBaseOwner(db: Db, userId: number, knowledgeBaseId: number) {
    const [record] = await db
        .select()
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, userId)))
        .limit(1)

    if (!record) {
        throw notFound("知识库不存在")
    }
    return record
}

export async function listWikiPages(userId: number, knowledgeBaseId: number) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const pages = await loadWikiPageRows(db, userId, knowledgeBaseId)

    return pages.map(toWikiPageResponse)
}

async function loadWikiPageRows(db: DbExecutor, userId: number, knowledgeBaseId: number) {
    return await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))
        .orderBy(asc(knowledgeBaseWikiPages.kind), asc(knowledgeBaseWikiPages.title))
}

export async function loadWikiPageDetail(userId: number, knowledgeBaseId: number, pageKey: string) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const page = await loadWikiPage(db, userId, knowledgeBaseId, pageKey)
    if (!page) {
        throw notFound("Wiki 页面不存在")
    }
    const sourceRefs = await db
        .select({
            id: knowledgeBaseWikiSourceRefs.id,
            articleId: knowledgeBaseWikiSourceRefs.articleId,
            anchor: knowledgeBaseWikiSourceRefs.anchor,
            note: knowledgeBaseWikiSourceRefs.note,
            articleTitle: knowledgeBaseArticles.title,
        })
        .from(knowledgeBaseWikiSourceRefs)
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseWikiSourceRefs.articleId, knowledgeBaseArticles.id))
        .where(eq(knowledgeBaseWikiSourceRefs.pageId, page.id))
        .orderBy(asc(knowledgeBaseWikiSourceRefs.id))

    const [links, inLinks, activePages] = await Promise.all([
        db
            .select()
            .from(knowledgeBaseWikiLinks)
            .where(eq(knowledgeBaseWikiLinks.fromPageId, page.id))
            .orderBy(asc(knowledgeBaseWikiLinks.toPageKey)),
        db
            .select()
            .from(knowledgeBaseWikiLinks)
            .where(and(
                eq(knowledgeBaseWikiLinks.userId, userId),
                eq(knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId),
                eq(knowledgeBaseWikiLinks.toPageKey, page.pageKey),
            ))
            .orderBy(asc(knowledgeBaseWikiLinks.fromPageId)),
        loadWikiPageRows(db, userId, knowledgeBaseId),
    ])
    const pageById = new Map(activePages.map((item) => [item.id, item]))
    const pageByKey = new Map(activePages.map((item) => [item.pageKey, item]))
    const outgoingRelations = new Map(
        collectKnowledgePageRelations(readKnowledgePageMetadata(page.frontmatterJson))
            .map((relation) => [`${relation.toPageKey}|${relation.relationType}`, relation] as const),
    )

    return {
        ...toWikiPageResponse(page),
        sourceRefs: sourceRefs.map((ref) => ({
            id: String(ref.id),
            articleId: String(ref.articleId),
            articleTitle: ref.articleTitle,
            anchor: ref.anchor,
            note: ref.note,
        })),
        links: links.map((link) => ({
            id: String(link.id),
            toPageKey: link.toPageKey,
            toPageTitle: pageByKey.get(link.toPageKey)?.title ?? link.toPageKey,
            toPageKind: pageByKey.get(link.toPageKey)?.kind ?? null,
            toPageSummary: pageByKey.get(link.toPageKey)?.summary ?? null,
            linkType: link.linkType,
            description: outgoingRelations.get(`${link.toPageKey}|${link.linkType}`)?.description ?? null,
        })),
        inLinks: inLinks.map((link) => {
            const fromPage = pageById.get(link.fromPageId)
            const incomingRelation = fromPage
                ? collectKnowledgePageRelations(readKnowledgePageMetadata(fromPage.frontmatterJson))
                    .find((relation) => relation.toPageKey === page.pageKey && relation.relationType === link.linkType)
                : null
            return {
                id: String(link.id),
                fromPageKey: fromPage?.pageKey ?? "",
                fromPageTitle: fromPage?.title ?? "未知页面",
                fromPageKind: fromPage?.kind ?? null,
                fromPageSummary: fromPage?.summary ?? null,
                linkType: link.linkType,
                description: incomingRelation?.description ?? null,
            }
        }),
    }
}

export async function loadWikiDashboard(userId: number, knowledgeBaseId: number) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const pageRows = await loadWikiPageRows(db, userId, knowledgeBaseId)
    const [lint, treeNodeRows, chunkRows, embedding] = await Promise.all([
        buildWikiLint(db, userId, knowledgeBaseId, pageRows),
        db
            .select({ value: count() })
            .from(knowledgeBaseWikiTreeNodes)
            .where(and(
                eq(knowledgeBaseWikiTreeNodes.userId, userId),
                eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
            )),
        db
            .select({ value: count() })
            .from(knowledgeBaseArticleChunks)
            .where(and(
                eq(knowledgeBaseArticleChunks.userId, userId),
                eq(knowledgeBaseArticleChunks.knowledgeBaseId, knowledgeBaseId),
            )),
        getKnowledgeBaseArticleIndexStatus(userId, knowledgeBaseId),
    ])

    return {
        pages: pageRows.map(toWikiPageResponse),
        lint,
        treeNodeCount: treeNodeRows[0]?.value ?? 0,
        chunkCount: chunkRows[0]?.value ?? 0,
        embedding,
    }
}

/**
 * 读取「构建知识」已持久化的文章切片与切片推荐问题。纯查询，不触发任何模型调用；
 * 正文改动后按 sourceHash 判定切片是否过期，UI 据此提示重新构建。
 */
export async function listArticleKnowledgeChunks(input: {
    userId: number
    knowledgeBaseId: number
    articleId: number
}) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, input.userId, input.knowledgeBaseId)
    const [article] = await db
        .select()
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.id, input.articleId),
            eq(knowledgeBaseArticles.userId, input.userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId),
        ))
        .limit(1)
    if (!article) throw notFound("文章不存在")

    const [chunkRows, sourcePage] = await Promise.all([
        db
            .select()
            .from(knowledgeBaseArticleChunks)
            .where(and(
                eq(knowledgeBaseArticleChunks.userId, input.userId),
                eq(knowledgeBaseArticleChunks.knowledgeBaseId, input.knowledgeBaseId),
                eq(knowledgeBaseArticleChunks.articleId, article.id),
            ))
            .orderBy(asc(knowledgeBaseArticleChunks.position)),
        loadWikiPage(db, input.userId, input.knowledgeBaseId, buildArticleSourcePageKey(article.id)),
    ])

    const builtHash = sourcePage ? getFrontmatterSourceHash(sourcePage) : null
    const chunkAlgorithmVersion = sourcePage ? getFrontmatterChunkAlgorithmVersion(sourcePage) : 0
    const currentHash = stableHash(`${article.title}\n${article.contentMd}`)
    const builtAt = chunkRows.reduce<Date | null>(
        (latest, row) => (latest && latest >= row.updatedAt ? latest : row.updatedAt),
        null,
    )

    const chunks = chunkRows.map((row) => ({
        id: String(row.id),
        chunkKey: row.chunkKey,
        position: row.position,
        heading: row.heading,
        contentMd: row.contentMd,
        charCount: row.contentMd.length,
        contentHash: row.contentHash,
        headingPath: parseStringArray(row.headingPathJson),
        recommendedQuestions: parseStringArray(row.recommendedQuestionsJson),
        updatedAt: formatDate(row.updatedAt),
    }))

    return {
        articleId: String(article.id),
        knowledgeBaseId: String(input.knowledgeBaseId),
        articleTitle: article.title,
        built: chunks.length > 0,
        // 两种过期：正文改动，或分片由旧版切分算法产出（存量数据无该字段，按 0 处理）。
        stale: chunks.length > 0 && (
            (builtHash != null && builtHash !== currentHash)
            || chunkAlgorithmVersion < CHUNK_ALGORITHM_VERSION
        ),
        chunkAlgorithmVersion,
        currentChunkAlgorithmVersion: CHUNK_ALGORITHM_VERSION,
        builtAt: formatDate(builtAt),
        chunkCount: chunks.length,
        questionCount: chunks.reduce((total, chunk) => total + chunk.recommendedQuestions.length, 0),
        chunks,
    }
}

function parseStringArray(raw: string | null | undefined) {
    const parsed = parseJsonObject(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((value) => String(value).trim()).filter(Boolean)
}

/**
 * 从知识库文章列表触发的单篇“构建知识”。Mastra Workflow 并发执行切片问题生成
 * 与整文候选抽取；候选确定后，再按页面批量生成独立 Wiki 正文并持久化页面关系。
 */
export async function buildArticleKnowledge(input: {
    userId: number
    knowledgeBaseId: number
    articleId: number
    forceRebuild?: boolean
}) {
    const db = getDb()
    const kb = await assertKnowledgeBaseOwner(db, input.userId, input.knowledgeBaseId)
    const [article] = await db
        .select()
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.id, input.articleId),
            eq(knowledgeBaseArticles.userId, input.userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId),
        ))
        .limit(1)
    if (!article) throw notFound("文章不存在")
    if (!article.contentMd.trim()) throw badRequest("文章没有可构建的 Markdown 内容")

    const sourceHash = stableHash(`${article.title}\n${article.contentMd}`)
    const sourcePageKey = buildArticleSourcePageKey(article.id)

    const existingKnowledgePageRows = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, input.userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, input.knowledgeBaseId),
            or(eq(knowledgeBaseWikiPages.kind, "entity"), eq(knowledgeBaseWikiPages.kind, "concept")),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))

    const workflowResult = await runArticleKnowledgeBuildWorkflow({
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        knowledgeBaseName: kb.name,
        articleId: article.id,
        articleTitle: article.title,
        contentMd: article.contentMd,
        existingPages: existingKnowledgePageRows.map((page) => {
            const metadata = readKnowledgePageMetadata(page.frontmatterJson)
            return {
                pageKey: page.pageKey,
                title: page.title,
                kind: page.kind === "concept" ? "concept" as const : "entity" as const,
                aliases: metadata.aliases,
                summary: page.summary ?? "",
                categoryPath: metadata.categoryPath,
                buildVersion: metadata.buildVersion,
            }
        }),
    })
    if (workflowResult.chunks.length === 0) throw badRequest("文章没有可构建的 Markdown 切片")

    let sourcePage: KnowledgeBaseWikiPageRecord | null = null
    await db.transaction(async (tx) => {
        await tx
            .delete(knowledgeBaseArticleChunks)
            .where(and(
                eq(knowledgeBaseArticleChunks.userId, input.userId),
                eq(knowledgeBaseArticleChunks.articleId, article.id),
            ))
        const insertedChunks = await tx.insert(knowledgeBaseArticleChunks).values(workflowResult.chunks.map((chunk) => ({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: article.id,
            chunkKey: chunk.chunkKey,
            position: chunk.position,
            heading: chunk.heading,
            headingPathJson: JSON.stringify(chunk.headingPath),
            contentMd: chunk.contentMd,
            contentHash: stableHash(chunk.contentMd),
            recommendedQuestionsJson: JSON.stringify(chunk.recommendedQuestions),
            updatedAt: new Date(),
        }))).returning()

        const indexValues = buildArticleKnowledgeIndexValues({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: article.id,
            articleTitle: article.title,
            chunks: insertedChunks,
        })
        if (indexValues.length > 0) {
            await tx.insert(knowledgeBaseArticleChunkIndexes).values(indexValues)
        }

        await detachArticleFromGeneratedKnowledgePages(tx, {
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: article.id,
        })
        await deleteWikiPageByKey(tx, {
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            pageKey: sourcePageKey,
        })

        const generatedPages: KnowledgeBaseWikiPageRecord[] = []
        for (const item of workflowResult.items) {
            generatedPages.push(await upsertExtractedKnowledgePage(tx, {
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                article,
                item,
            }))
        }
        await rebuildGeneratedKnowledgePageLinks(tx, input.userId, input.knowledgeBaseId)

        sourcePage = await upsertWikiPage(tx, {
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            pageKey: sourcePageKey,
            title: article.title,
            kind: "source",
            contentMd: renderBuiltSourcePage(article, workflowResult),
            summary: workflowResult.documentSummary,
            frontmatter: {
                generatedBy: "article-knowledge-build",
                buildVersion: ARTICLE_KNOWLEDGE_BUILD_VERSION,
                chunkAlgorithmVersion: CHUNK_ALGORITHM_VERSION,
                articleId: String(article.id),
                sourceTitle: article.title,
                sourceUpdatedAt: formatDate(article.updatedAt),
                sourceHash,
                chunkCount: workflowResult.chunks.length,
                recommendedQuestionCount: workflowResult.chunks.length * 3,
                entityCount: workflowResult.items.filter((item) => item.kind === "entity").length,
                conceptCount: workflowResult.items.filter((item) => item.kind === "concept").length,
            },
            sourceRefs: [{ articleId: article.id, anchor: null, note: "源文档" }],
        })

        await tx.delete(knowledgeBaseWikiLinks).where(eq(knowledgeBaseWikiLinks.fromPageId, sourcePage.id))
        if (generatedPages.length > 0) {
            await tx.insert(knowledgeBaseWikiLinks).values(generatedPages.map((page) => ({
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                fromPageId: sourcePage!.id,
                toPageKey: page.pageKey,
                linkType: "extracts",
            })))
        }

        await rebuildWikiIndex(tx, input.userId, input.knowledgeBaseId, kb.name)
    })

    await logWikiEvent(db, input.userId, input.knowledgeBaseId, "ARTICLE_KNOWLEDGE_BUILD", sourcePage!.id, null, {
        articleId: article.id,
        chunkCount: workflowResult.chunks.length,
        entityCount: workflowResult.items.filter((item) => item.kind === "entity").length,
        conceptCount: workflowResult.items.filter((item) => item.kind === "concept").length,
        warnings: workflowResult.warnings,
    })

    // 外部向量调用不能占用数据库事务。提交后严格按“全部分片 → 全部问题”的顺序
    // best-effort 建索引；失败时 Wiki 与 BM25 仍可用，不回滚已经生成的知识。
    await embedKnowledgeBaseArticleIndexBestEffort(input.userId, input.knowledgeBaseId).catch((error: unknown) => {
        workflowResult.warnings.push(error instanceof Error
            ? `分片检索向量生成失败：${error.message}`
            : "分片检索向量生成失败")
    })

    return buildArticleKnowledgeResponse({
        article,
        sourcePage: sourcePage!,
        fromCache: false,
        chunkCount: workflowResult.chunks.length,
        entityCount: workflowResult.items.filter((item) => item.kind === "entity").length,
        conceptCount: workflowResult.items.filter((item) => item.kind === "concept").length,
        warnings: workflowResult.warnings,
    })
}

export async function ingestKnowledgeBaseWiki(input: {
    userId: number
    knowledgeBaseId: number
    articleIds?: number[]
    forceRebuild?: boolean
    /** 完全重建：先清空该知识库下的全部 Wiki 数据，再从源文章从零编译。 */
    fullRebuild?: boolean
}) {
    const db = getDb()
    const kb = await assertKnowledgeBaseOwner(db, input.userId, input.knowledgeBaseId)
    if (input.fullRebuild && input.articleIds?.length) {
        throw badRequest("完全重建会清空整个知识库的 Wiki，不能同时指定文章范围")
    }

    // 完全重建先清空旧数据，再走与增量一致的编译流程；清空后所有缓存判定自然失效，
    // 但仍显式打开 forceRebuild，保证目录树等按结构指纹缓存的子流程也重新生成。
    const purged = input.fullRebuild
        ? await purgeKnowledgeBaseWiki(db, input.userId, input.knowledgeBaseId)
        : null
    const forceRebuild = Boolean(input.forceRebuild || input.fullRebuild)

    const graph = await loadKnowledgeBaseArticles(db, input.userId, input.knowledgeBaseId, input.articleIds)
    const pages: KnowledgeBaseWikiPageRecord[] = []
    const warnings: string[] = []
    let orphanedPageCount = 0
    // 完全重建已经清空了所有页面，不存在孤儿页，跳过这一步扫描。
    if (!input.articleIds?.length && !purged) {
        orphanedPageCount = await pruneOrphanArticleWikiPages(
            db,
            input.userId,
            input.knowledgeBaseId,
            graph.articles.map((article) => article.id),
        )
        if (orphanedPageCount > 0) {
            warnings.push(`已清理 ${orphanedPageCount} 个失去源文章的 Wiki 页面`)
        }
    }
    const eventType = input.fullRebuild ? "REBUILD" : "INGEST"

    if (graph.articles.length === 0) {
        // 清空过内容时不再报错：知识库确实没有文章，但仍要把索引页重建成空索引。
        if (orphanedPageCount === 0 && (purged?.pageCount ?? 0) === 0) {
            throw badRequest("知识库里还没有可编译的文章")
        }
        const indexPage = await rebuildWikiIndex(db, input.userId, input.knowledgeBaseId, kb.name)
        await logWikiEvent(db, input.userId, input.knowledgeBaseId, eventType, indexPage.id, null, {
            articleCount: 0,
            pageCount: 1,
            purged,
            warnings,
        })
        return {
            knowledgeBaseId: String(input.knowledgeBaseId),
            indexPage: toWikiPageResponse(indexPage),
            pages: [],
            purged,
            warnings,
        }
    }

    for (const article of graph.articles) {
        const sourceHash = stableHash(`${article.title}\n${article.contentMd}`)
        const pageKey = buildArticleSourcePageKey(article.id)
        const existing = await loadWikiPage(db, input.userId, input.knowledgeBaseId, pageKey)
        let page: KnowledgeBaseWikiPageRecord
        if (existing && getFrontmatterSourceHash(existing) === sourceHash && !forceRebuild) {
            page = existing
        } else {
            const draft = await generateArticleWikiDraft({
                userId: input.userId,
                knowledgeBaseName: kb.name,
                article,
            }).catch((error: unknown) => {
                warnings.push(error instanceof Error ? error.message : "模型编译失败，已使用本地摘要策略")
                return buildFallbackArticleWikiDraft(article)
            })
            const contentMd = renderArticleWikiPage(article, draft)
            page = await upsertWikiPage(db, {
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                pageKey,
                title: article.title,
                kind: "source",
                contentMd,
                summary: draft.summary,
                frontmatter: {
                    articleId: String(article.id),
                    sourceTitle: article.title,
                    sourceUpdatedAt: formatDate(article.updatedAt),
                    sourceHash,
                    entities: draft.entities,
                    questions: draft.questions,
                },
                sourceRefs: [{ articleId: article.id, anchor: null, note: "源文档" }],
            })
        }
        pages.push(page)

        // PageIndex 式目录树：把源文档拆成层级节点供推理式检索。内部按结构指纹缓存，结构未变会跳过。
        await buildArticleTree({
            db,
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            knowledgeBaseName: kb.name,
            pageId: page.id,
            article,
            forceRebuild,
        }).catch((error: unknown) => {
            warnings.push(error instanceof Error ? `目录树构建失败：${error.message}` : "目录树构建失败")
        })
    }

    const indexPage = await rebuildWikiIndex(db, input.userId, input.knowledgeBaseId, kb.name)
    await logWikiEvent(db, input.userId, input.knowledgeBaseId, eventType, indexPage.id, null, {
        articleCount: graph.articles.length,
        pageCount: pages.length + 1,
        purged,
        warnings,
    })

    // best-effort：编译后自动为新章节节点补写向量（已配置向量模型时才执行），失败不影响编译结果
    await embedKnowledgeBaseTreeNodesBestEffort(input.userId, input.knowledgeBaseId).catch((error: unknown) => {
        warnings.push(error instanceof Error ? `向量生成失败：${error.message}` : "向量生成失败")
    })

    return {
        knowledgeBaseId: String(input.knowledgeBaseId),
        indexPage: toWikiPageResponse(indexPage),
        pages: pages.map(toWikiPageResponse),
        purged,
        warnings: [...new Set(warnings)].slice(0, 5),
    }
}

/**
 * 清空知识库下的全部 Wiki 数据：页面（含问答沉淀的概念/答案页）、页面链接、
 * 来源引用和 PageIndex 目录树节点（含其上的向量）。
 *
 * 两点刻意保留：
 * - 事件日志作为审计记录保留，只解除对即将删除页面的引用（page_id 置空）；
 * - 待审批补丁保持 PENDING，因为源文章仍在，重建后合并补丁会重新生成对应页面。
 */
async function purgeKnowledgeBaseWiki(
    db: DbExecutor,
    userId: number,
    knowledgeBaseId: number,
): Promise<WikiPurgeSummary> {
    const pages = await db
        .select({ id: knowledgeBaseWikiPages.id })
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
        ))
    const pageIds = pages.map((page) => page.id)

    const [linkRow] = await db
        .select({ value: count() })
        .from(knowledgeBaseWikiLinks)
        .where(and(
            eq(knowledgeBaseWikiLinks.userId, userId),
            eq(knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId),
        ))
    const [treeNodeRow] = await db
        .select({ value: count() })
        .from(knowledgeBaseWikiTreeNodes)
        .where(and(
            eq(knowledgeBaseWikiTreeNodes.userId, userId),
            eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
        ))
    const sourceRefs = pageIds.length === 0
        ? []
        : await db
            .select({ id: knowledgeBaseWikiSourceRefs.id })
            .from(knowledgeBaseWikiSourceRefs)
            .where(inArray(knowledgeBaseWikiSourceRefs.pageId, pageIds))

    const summary: WikiPurgeSummary = {
        pageCount: pageIds.length,
        linkCount: linkRow?.value ?? 0,
        treeNodeCount: treeNodeRow?.value ?? 0,
        sourceRefCount: sourceRefs.length,
    }

    if (pageIds.length > 0) {
        await db
            .update(knowledgeBaseWikiEventLogs)
            .set({ pageId: null })
            .where(and(
                eq(knowledgeBaseWikiEventLogs.userId, userId),
                eq(knowledgeBaseWikiEventLogs.knowledgeBaseId, knowledgeBaseId),
            ))
        await db
            .delete(knowledgeBaseWikiSourceRefs)
            .where(inArray(knowledgeBaseWikiSourceRefs.pageId, pageIds))
    }

    // 子表先删，避免本地 SQLite（无级联）留下孤儿行。
    await db
        .delete(knowledgeBaseWikiLinks)
        .where(and(
            eq(knowledgeBaseWikiLinks.userId, userId),
            eq(knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId),
        ))
    await db
        .delete(knowledgeBaseWikiTreeNodes)
        .where(and(
            eq(knowledgeBaseWikiTreeNodes.userId, userId),
            eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
        ))
    await db
        .delete(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
        ))

    return summary
}

/**
 * 删除文章对应的 source-<articleId> Wiki 页面及其派生数据。
 *
 * Wiki 页面没有 article_id 外键，文章删除时数据库只能级联清理 source_ref / tree_node，
 * 无法反向删除页面本身；同时 wiki_link.to_page_key 也是文本引用，需要在这里显式清理。
 */
export async function deleteArticleWikiPages(
    db: DbExecutor,
    input: {
        userId: number
        articles: ArticleWikiDeletionTarget[]
        rebuildIndex?: boolean
    },
) {
    const targetsByKnowledgeBase = new Map<number, number[]>()
    for (const article of input.articles) {
        const articleIds = targetsByKnowledgeBase.get(article.knowledgeBaseId) ?? []
        articleIds.push(article.id)
        targetsByKnowledgeBase.set(article.knowledgeBaseId, articleIds)
    }

    let deletedPageCount = 0
    for (const [knowledgeBaseId, rawArticleIds] of targetsByKnowledgeBase) {
        const articleIds = [...new Set(rawArticleIds)]
        const pageKeys = articleIds.map(buildArticleSourcePageKey)
        const pages = await db
            .select({ id: knowledgeBaseWikiPages.id })
            .from(knowledgeBaseWikiPages)
            .where(and(
                eq(knowledgeBaseWikiPages.userId, input.userId),
                eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
                eq(knowledgeBaseWikiPages.kind, "source"),
                inArray(knowledgeBaseWikiPages.pageKey, pageKeys),
            ))

        if (pages.length === 0) continue

        const pageIds = pages.map((page) => page.id)
        const now = new Date()

        // 事件日志作为审计记录保留，但不能继续引用即将删除的页面。
        await db
            .update(knowledgeBaseWikiEventLogs)
            .set({ pageId: null })
            .where(inArray(knowledgeBaseWikiEventLogs.pageId, pageIds))

        // from_page_id 有外键级联，to_page_key 只是文本；两类链接都显式清理，兼容本地 SQLite。
        await db
            .delete(knowledgeBaseWikiLinks)
            .where(and(
                eq(knowledgeBaseWikiLinks.userId, input.userId),
                eq(knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId),
                or(
                    inArray(knowledgeBaseWikiLinks.fromPageId, pageIds),
                    inArray(knowledgeBaseWikiLinks.toPageKey, pageKeys),
                ),
            ))
        await db
            .delete(knowledgeBaseWikiSourceRefs)
            .where(inArray(knowledgeBaseWikiSourceRefs.pageId, pageIds))
        await db
            .delete(knowledgeBaseWikiTreeNodes)
            .where(inArray(knowledgeBaseWikiTreeNodes.pageId, pageIds))
        await db
            .delete(knowledgeBaseWikiPages)
            .where(and(
                eq(knowledgeBaseWikiPages.userId, input.userId),
                eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
                inArray(knowledgeBaseWikiPages.id, pageIds),
            ))

        // 防止待审批补丁在文章删除后重新创建同名 source 页面；保留记录用于审计。
        await db
            .update(knowledgeBaseWikiPatches)
            .set({ status: "REJECTED", updatedAt: now })
            .where(and(
                eq(knowledgeBaseWikiPatches.userId, input.userId),
                eq(knowledgeBaseWikiPatches.knowledgeBaseId, knowledgeBaseId),
                eq(knowledgeBaseWikiPatches.status, "PENDING"),
                inArray(knowledgeBaseWikiPatches.pageKey, pageKeys),
            ))

        deletedPageCount += pageIds.length

        if (input.rebuildIndex !== false) {
            const [knowledgeBase] = await db
                .select({ name: knowledgeBases.name })
                .from(knowledgeBases)
                .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, input.userId)))
                .limit(1)
            if (knowledgeBase) {
                await rebuildWikiIndex(db, input.userId, knowledgeBaseId, knowledgeBase.name)
            }
        }
    }

    return deletedPageCount
}

async function pruneOrphanArticleWikiPages(
    db: DbExecutor,
    userId: number,
    knowledgeBaseId: number,
    validArticleIds: number[],
) {
    const sourcePages = await db
        .select({ pageKey: knowledgeBaseWikiPages.pageKey })
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseWikiPages.kind, "source"),
        ))
    const validIds = new Set(validArticleIds)
    const orphanedArticles = sourcePages.flatMap((page) => {
        const match = page.pageKey.match(/^source-(\d+)$/)
        if (!match) return []
        const articleId = Number(match[1])
        return validIds.has(articleId) ? [] : [{ id: articleId, knowledgeBaseId }]
    })
    if (orphanedArticles.length === 0) return 0

    return deleteArticleWikiPages(db, {
        userId,
        articles: orphanedArticles,
        rebuildIndex: false,
    })
}

export async function listWikiPatches(userId: number, knowledgeBaseId: number, status?: WikiPatchStatus) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const where = status
        ? and(
            eq(knowledgeBaseWikiPatches.userId, userId),
            eq(knowledgeBaseWikiPatches.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseWikiPatches.status, status),
        )
        : and(eq(knowledgeBaseWikiPatches.userId, userId), eq(knowledgeBaseWikiPatches.knowledgeBaseId, knowledgeBaseId))

    const rows = await db
        .select()
        .from(knowledgeBaseWikiPatches)
        .where(where)
        .orderBy(desc(knowledgeBaseWikiPatches.updatedAt))
        .limit(100)

    return rows.map(toWikiPatchResponse)
}

export async function applyWikiPatch(userId: number, knowledgeBaseId: number, patchId: number) {
    const db = getDb()
    const kb = await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const patch = await loadPatch(db, userId, knowledgeBaseId, patchId)
    if (patch.status !== "PENDING") {
        throw badRequest("只能处理待审批补丁")
    }

    const page = await upsertWikiPage(db, {
        userId,
        knowledgeBaseId,
        pageKey: patch.pageKey,
        title: patch.title,
        kind: patch.operation === "CREATE" ? "answer" : "concept",
        contentMd: patch.proposedContentMd,
        summary: summarizePlainText(patch.proposedContentMd, 180),
        frontmatter: {
            patchId: String(patch.id),
            reason: patch.reason,
        },
        sourceRefs: [],
    })
    const now = new Date()
    const [updated] = await db
        .update(knowledgeBaseWikiPatches)
        .set({ status: "APPLIED", appliedAt: now, updatedAt: now })
        .where(and(eq(knowledgeBaseWikiPatches.id, patch.id), eq(knowledgeBaseWikiPatches.userId, userId)))
        .returning()
    await rebuildWikiIndex(db, userId, knowledgeBaseId, kb.name)
    await logWikiEvent(db, userId, knowledgeBaseId, "PATCH_APPLIED", page.id, patch.threadId, {
        patchId: String(patch.id),
        pageKey: patch.pageKey,
    })

    return {
        patch: toWikiPatchResponse(updated),
        page: toWikiPageResponse(page),
    }
}

export async function rejectWikiPatch(userId: number, knowledgeBaseId: number, patchId: number) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const patch = await loadPatch(db, userId, knowledgeBaseId, patchId)
    if (patch.status !== "PENDING") {
        throw badRequest("只能处理待审批补丁")
    }
    const [updated] = await db
        .update(knowledgeBaseWikiPatches)
        .set({ status: "REJECTED", updatedAt: new Date() })
        .where(and(eq(knowledgeBaseWikiPatches.id, patch.id), eq(knowledgeBaseWikiPatches.userId, userId)))
        .returning()
    await logWikiEvent(db, userId, knowledgeBaseId, "PATCH_REJECTED", null, patch.threadId, {
        patchId: String(patch.id),
        pageKey: patch.pageKey,
    })
    return toWikiPatchResponse(updated)
}

export async function listAgentThreads(userId: number, knowledgeBaseId: number) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const rows = await db
        .select()
        .from(knowledgeBaseAgentThreads)
        .where(and(eq(knowledgeBaseAgentThreads.userId, userId), eq(knowledgeBaseAgentThreads.knowledgeBaseId, knowledgeBaseId)))
        .orderBy(desc(knowledgeBaseAgentThreads.updatedAt), desc(knowledgeBaseAgentThreads.id))
        .limit(50)

    return rows.map((row) => toAgentThreadResponse(row))
}

export async function createAgentThread(input: {
    userId: number
    knowledgeBaseId: number | null
    title?: string | null
    metadata?: unknown
}) {
    const db = getDb()
    if (input.knowledgeBaseId != null) {
        await assertKnowledgeBaseOwner(db, input.userId, input.knowledgeBaseId)
    }
    const now = new Date()
    const [thread] = await db
        .insert(knowledgeBaseAgentThreads)
        .values({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            title: input.title?.trim() || "文档问答",
            lastMessageAt: now,
            metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
        })
        .returning()

    return thread
}

export async function ensureAgentThread(input: {
    userId: number
    knowledgeBaseId: number | null
    threadId?: number | null
    title?: string | null
}) {
    if (input.threadId != null) {
        return await loadAgentThreadOrThrow(input.userId, input.threadId, input.knowledgeBaseId)
    }
    return await createAgentThread(input)
}

export async function loadAgentThreadOrThrow(userId: number, threadId: number, expectedKnowledgeBaseId?: number | null) {
    const db = getDb()
    const [thread] = await db
        .select()
        .from(knowledgeBaseAgentThreads)
        .where(and(
            eq(knowledgeBaseAgentThreads.id, threadId),
            eq(knowledgeBaseAgentThreads.userId, userId),
        ))
        .limit(1)
    if (!thread) {
        throw notFound("对话线程不存在")
    }
    if (expectedKnowledgeBaseId !== undefined && expectedKnowledgeBaseId !== null
        && thread.knowledgeBaseId !== expectedKnowledgeBaseId) {
        throw notFound("对话线程不存在")
    }
    return thread
}

export async function loadAgentThreadDetail(userId: number, threadId: number, expectedKnowledgeBaseId?: number | null) {
    const thread = await loadAgentThreadOrThrow(userId, threadId, expectedKnowledgeBaseId)
    const db = getDb()
    const messages = await db
        .select()
        .from(knowledgeBaseAgentMessages)
        .where(eq(knowledgeBaseAgentMessages.threadId, thread.id))
        .orderBy(asc(knowledgeBaseAgentMessages.createdAt), asc(knowledgeBaseAgentMessages.id))
        .limit(200)

    const kbName = thread.knowledgeBaseId == null
        ? null
        : await loadKnowledgeBaseName(db, userId, thread.knowledgeBaseId)

    return {
        thread: toAgentThreadResponse(thread, kbName),
        messages: messages.map((message) => ({
            id: String(message.id),
            role: message.role,
            contentText: message.contentText,
            content: parseJsonObject(message.contentJson),
            metadata: parseJsonObject(message.metadataJson),
            createdAt: formatDate(message.createdAt),
        })),
    }
}

async function loadKnowledgeBaseName(db: Db, userId: number, knowledgeBaseId: number) {
    const [kb] = await db
        .select({ name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, userId)))
        .limit(1)
    return kb?.name ?? null
}

export async function deleteAgentThread(userId: number, threadId: number) {
    const db = getDb()
    const thread = await loadAgentThreadOrThrow(userId, threadId)

    await db.delete(knowledgeBaseAgentMessages).where(eq(knowledgeBaseAgentMessages.threadId, thread.id))

    const runs = await db
        .select({ id: knowledgeBaseAgentRuns.id })
        .from(knowledgeBaseAgentRuns)
        .where(eq(knowledgeBaseAgentRuns.threadId, thread.id))
    if (runs.length > 0) {
        const runIds = runs.map((row) => row.id)
        await db.delete(knowledgeBaseAgentSteps).where(inArray(knowledgeBaseAgentSteps.runId, runIds))
        await db.delete(knowledgeBaseAgentRuns).where(inArray(knowledgeBaseAgentRuns.id, runIds))
    }

    await db.delete(knowledgeBaseAgentArtifacts).where(eq(knowledgeBaseAgentArtifacts.threadId, thread.id))

    if (thread.knowledgeBaseId != null) {
        await db
            .update(knowledgeBaseWikiPatches)
            .set({ threadId: null })
            .where(and(
                eq(knowledgeBaseWikiPatches.userId, userId),
                eq(knowledgeBaseWikiPatches.threadId, thread.id),
            ))
        await db
            .update(knowledgeBaseWikiEventLogs)
            .set({ threadId: null })
            .where(and(
                eq(knowledgeBaseWikiEventLogs.userId, userId),
                eq(knowledgeBaseWikiEventLogs.threadId, thread.id),
            ))
    }

    await db
        .delete(knowledgeBaseAgentThreads)
        .where(and(eq(knowledgeBaseAgentThreads.id, thread.id), eq(knowledgeBaseAgentThreads.userId, userId)))

    return { id: String(thread.id) }
}

export type ListAgentThreadsScope =
    | { type: "all" }
    | { type: "cross" }
    | { type: "kb"; knowledgeBaseId: number }

export function parseAgentThreadScope(raw: string | undefined | null): ListAgentThreadsScope | null {
    if (raw === undefined || raw === null || raw === "" || raw === "all") return { type: "all" }
    if (raw === "cross") return { type: "cross" }
    const id = Number(String(raw).trim())
    if (!Number.isInteger(id) || id <= 0) return null
    return { type: "kb", knowledgeBaseId: id }
}

export async function listAllAgentThreads(
    userId: number,
    options: {
        cursor?: number
        limit?: number
        query?: string
        scope?: ListAgentThreadsScope
    } = {},
) {
    const db = getDb()
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100)
    const offset = options.cursor ?? 0
    const scope = options.scope ?? { type: "all" }

    const filters = [eq(knowledgeBaseAgentThreads.userId, userId)]
    if (scope.type === "cross") {
        filters.push(isNull(knowledgeBaseAgentThreads.knowledgeBaseId))
    } else if (scope.type === "kb") {
        filters.push(eq(knowledgeBaseAgentThreads.knowledgeBaseId, scope.knowledgeBaseId))
    }
    const keyword = options.query?.trim()
    if (keyword) {
        const pattern = `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        const titleMatch = like(knowledgeBaseAgentThreads.title, pattern)
        const kbMatch = like(knowledgeBases.name, pattern)
        const combined = or(titleMatch, kbMatch)
        if (combined) filters.push(combined)
    }

    const rows = await db
        .select({
            thread: knowledgeBaseAgentThreads,
            kbName: knowledgeBases.name,
        })
        .from(knowledgeBaseAgentThreads)
        .leftJoin(knowledgeBases, eq(knowledgeBaseAgentThreads.knowledgeBaseId, knowledgeBases.id))
        .where(and(...filters))
        .orderBy(desc(knowledgeBaseAgentThreads.updatedAt), desc(knowledgeBaseAgentThreads.id))
        .limit(limit + 1)
        .offset(offset)

    const hasMore = rows.length > limit
    const sliced = hasMore ? rows.slice(0, limit) : rows
    return {
        threads: sliced.map((row) => toAgentThreadResponse(row.thread, row.kbName)),
        nextCursor: hasMore ? offset + limit : null,
    }
}

export async function deleteAgentThreads(userId: number, threadIds: number[]) {
    if (threadIds.length === 0) {
        return { deleted: [] as string[], failed: [] as Array<{ id: string; reason: string }> }
    }
    const db = getDb()
    const uniqueIds = Array.from(new Set(threadIds))
    const ownedRows = await db
        .select({ id: knowledgeBaseAgentThreads.id })
        .from(knowledgeBaseAgentThreads)
        .where(and(
            eq(knowledgeBaseAgentThreads.userId, userId),
            inArray(knowledgeBaseAgentThreads.id, uniqueIds),
        ))
    const ownedIds = ownedRows.map((row) => row.id)
    const ownedSet = new Set(ownedIds.map((id) => String(id)))
    const failed = uniqueIds
        .filter((id) => !ownedSet.has(String(id)))
        .map((id) => ({ id: String(id), reason: "对话不存在或无权限" }))

    if (ownedIds.length === 0) {
        return { deleted: [] as string[], failed }
    }

    await db.transaction(async (tx) => {
        const runs = await tx
            .select({ id: knowledgeBaseAgentRuns.id })
            .from(knowledgeBaseAgentRuns)
            .where(inArray(knowledgeBaseAgentRuns.threadId, ownedIds))
        const runIds = runs.map((row) => row.id)

        if (runIds.length > 0) {
            await tx
                .delete(knowledgeBaseAgentSteps)
                .where(inArray(knowledgeBaseAgentSteps.runId, runIds))
        }

        await tx
            .delete(knowledgeBaseAgentMessages)
            .where(inArray(knowledgeBaseAgentMessages.threadId, ownedIds))

        if (runIds.length > 0) {
            await tx
                .delete(knowledgeBaseAgentRuns)
                .where(inArray(knowledgeBaseAgentRuns.id, runIds))
        }

        await tx
            .delete(knowledgeBaseAgentArtifacts)
            .where(inArray(knowledgeBaseAgentArtifacts.threadId, ownedIds))

        await tx
            .update(knowledgeBaseWikiPatches)
            .set({ threadId: null })
            .where(and(
                eq(knowledgeBaseWikiPatches.userId, userId),
                inArray(knowledgeBaseWikiPatches.threadId, ownedIds),
            ))

        await tx
            .update(knowledgeBaseWikiEventLogs)
            .set({ threadId: null })
            .where(and(
                eq(knowledgeBaseWikiEventLogs.userId, userId),
                inArray(knowledgeBaseWikiEventLogs.threadId, ownedIds),
            ))

        await tx
            .delete(knowledgeBaseAgentThreads)
            .where(and(
                eq(knowledgeBaseAgentThreads.userId, userId),
                inArray(knowledgeBaseAgentThreads.id, ownedIds),
            ))
    })

    return {
        deleted: ownedIds.map((id) => String(id)),
        failed,
    }
}

export async function listUserKnowledgeBases(userId: number) {
    const db = getDb()
    const rows = await db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name, description: knowledgeBases.description })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.userId, userId))
        .orderBy(asc(knowledgeBases.name))
    return rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        description: row.description,
    }))
}

export async function searchWikiPagesAcrossKbs(input: {
    userId: number
    query: string
    limit?: number
}) {
    const db = getDb()
    const limit = input.limit ?? 10
    const query = input.query.trim()
    const [pageRows, articleRows] = await Promise.all([
        db
            .select({
                page: knowledgeBaseWikiPages,
                kbName: knowledgeBases.name,
            })
            .from(knowledgeBaseWikiPages)
            .innerJoin(knowledgeBases, eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBases.id))
            .where(eq(knowledgeBaseWikiPages.userId, input.userId))
            .orderBy(desc(knowledgeBaseWikiPages.updatedAt))
            .limit(500),
        db
            .select({
                article: knowledgeBaseArticles,
                kbName: knowledgeBases.name,
            })
            .from(knowledgeBaseArticles)
            .innerJoin(knowledgeBases, eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBases.id))
            .where(eq(knowledgeBaseArticles.userId, input.userId))
            .orderBy(desc(knowledgeBaseArticles.updatedAt))
            .limit(500),
    ])

    type CrossHit = {
        knowledgeBaseId: string
        knowledgeBaseName: string
        pageKey: string
        articleId: string | null
        href: string | null
        title: string
        kind: string
        summary: string
        updatedAt: string
        score: number
        sortTime: number
    }

    const byKey = new Map<string, CrossHit>()

    for (const { page, kbName } of pageRows) {
        const score = scoreWikiPage(page, query)
        if (score <= 0 && query) continue
        const articleId = extractArticleIdFromPageKey(page.pageKey)
        const key = articleId
            ? `article:${page.knowledgeBaseId}:${articleId}`
            : `page:${page.knowledgeBaseId}:${page.pageKey}`
        const hit: CrossHit = {
            knowledgeBaseId: String(page.knowledgeBaseId),
            knowledgeBaseName: kbName,
            pageKey: page.pageKey,
            articleId,
            href: sourceArticleHref(page.knowledgeBaseId, articleId),
            title: page.title,
            kind: page.kind,
            summary: page.summary || summarizePlainText(page.contentMd, 180),
            updatedAt: formatDate(page.updatedAt) ?? "",
            score: score || 1,
            sortTime: page.updatedAt.getTime(),
        }
        const existing = byKey.get(key)
        if (!existing || hit.score > existing.score) byKey.set(key, hit)
    }

    // Wiki 未编译或标题只在文章表时，用文章标题/摘要补召回
    for (const { article, kbName } of articleRows) {
        const score = scoreSearchFields({
            title: article.title,
            summary: article.aiSummary ?? article.publicExcerpt,
            content: article.contentMd,
        }, query)
        if (score <= 0 && query) continue
        const key = `article:${article.knowledgeBaseId}:${article.id}`
        const hit: CrossHit = {
            knowledgeBaseId: String(article.knowledgeBaseId),
            knowledgeBaseName: kbName,
            pageKey: `source-${article.id}`,
            articleId: String(article.id),
            href: knowledgeBaseArticlePath(String(article.knowledgeBaseId), String(article.id)),
            title: article.title,
            kind: "source",
            summary: article.aiSummary?.trim()
                || article.publicExcerpt?.trim()
                || summarizePlainText(article.contentMd, 180),
            updatedAt: formatDate(article.updatedAt) ?? "",
            score: score || 1,
            sortTime: article.updatedAt.getTime(),
        }
        const existing = byKey.get(key)
        if (!existing || hit.score > existing.score) byKey.set(key, hit)
    }

    return Array.from(byKey.values())
        .sort((left, right) => right.score - left.score || right.sortTime - left.sortTime)
        .slice(0, limit)
        .map((item) => {
            const { score, sortTime, ...hit } = item
            void score
            void sortTime
            return hit
        })
}

function extractArticleIdFromPageKey(pageKey: string): string | null {
    const match = pageKey.match(/^source-(\d+)$/)
    return match ? match[1] : null
}

function sourceArticleHref(knowledgeBaseId: number | string, articleId: string | null) {
    return articleId ? knowledgeBaseArticlePath(String(knowledgeBaseId), articleId) : null
}

export async function readWikiPageAnyKb(userId: number, knowledgeBaseId: number, pageKey: string) {
    return await readWikiPageForAgent(userId, knowledgeBaseId, pageKey)
}

export async function createAgentRun(input: {
    userId: number
    knowledgeBaseId: number | null
    threadId: number
    modelName?: string | null
}) {
    const [run] = await getDb()
        .insert(knowledgeBaseAgentRuns)
        .values({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            threadId: input.threadId,
            modelName: input.modelName ?? null,
        })
        .returning()
    return run
}

export async function finishAgentRun(input: {
    runId: number
    userId: number
    status: "COMPLETED" | "FAILED" | "CANCELLED"
    errorMessage?: string | null
}) {
    await getDb()
        .update(knowledgeBaseAgentRuns)
        .set({
            status: input.status,
            errorMessage: input.errorMessage ?? null,
            finishedAt: new Date(),
        })
        .where(and(eq(knowledgeBaseAgentRuns.id, input.runId), eq(knowledgeBaseAgentRuns.userId, input.userId)))
}

export async function recordAgentStep(input: {
    runId: number
    userId: number
    knowledgeBaseId: number | null
    stepType: string
    title: string
    status: "RUNNING" | "COMPLETED" | "FAILED"
    payload?: unknown
}) {
    const now = new Date()
    await getDb()
        .insert(knowledgeBaseAgentSteps)
        .values({
            runId: input.runId,
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            stepType: input.stepType,
            title: input.title,
            status: input.status,
            payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
            startedAt: now,
            finishedAt: input.status === "RUNNING" ? null : now,
        })
}

export async function persistAgentMessage(input: {
    userId: number
    knowledgeBaseId: number | null
    threadId: number
    role: "user" | "assistant" | "system" | "tool"
    contentText: string
    content?: unknown
    metadata?: unknown
}) {
    const now = new Date()
    const [message] = await getDb()
        .insert(knowledgeBaseAgentMessages)
        .values({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            threadId: input.threadId,
            role: input.role,
            contentText: input.contentText,
            contentJson: input.content === undefined ? null : JSON.stringify(input.content),
            metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
            createdAt: now,
        })
        .returning()

    await getDb()
        .update(knowledgeBaseAgentThreads)
        .set({
            lastMessageAt: now,
            updatedAt: now,
            ...(input.role === "user" && input.contentText.trim()
                ? { title: summarizePlainText(input.contentText, 40) }
                : {}),
        })
        .where(and(eq(knowledgeBaseAgentThreads.id, input.threadId), eq(knowledgeBaseAgentThreads.userId, input.userId)))

    return message
}

export async function listAgentArtifacts(userId: number, knowledgeBaseId: number, threadId?: number | null) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const where = threadId == null
        ? and(eq(knowledgeBaseAgentArtifacts.userId, userId), eq(knowledgeBaseAgentArtifacts.knowledgeBaseId, knowledgeBaseId))
        : and(
            eq(knowledgeBaseAgentArtifacts.userId, userId),
            eq(knowledgeBaseAgentArtifacts.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseAgentArtifacts.threadId, threadId),
        )

    const rows = await db
        .select()
        .from(knowledgeBaseAgentArtifacts)
        .where(where)
        .orderBy(desc(knowledgeBaseAgentArtifacts.updatedAt))
        .limit(100)

    return rows.map(toAgentArtifactResponse)
}

export async function createAgentArtifact(input: {
    userId: number
    knowledgeBaseId: number | null
    threadId: number
    runId?: number | null
    artifactType: string
    title: string
    payload?: unknown
    contentMd?: string | null
}) {
    const [artifact] = await getDb()
        .insert(knowledgeBaseAgentArtifacts)
        .values({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            threadId: input.threadId,
            runId: input.runId ?? null,
            artifactType: input.artifactType,
            title: input.title,
            payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
            contentMd: input.contentMd ?? null,
        })
        .returning()
    return toAgentArtifactResponse(artifact)
}

export async function runWikiLint(userId: number, knowledgeBaseId: number) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const pages = await loadWikiPageRows(db, userId, knowledgeBaseId)
    return await buildWikiLint(db, userId, knowledgeBaseId, pages)
}

async function buildWikiLint(
    db: DbExecutor,
    userId: number,
    knowledgeBaseId: number,
    pages: KnowledgeBaseWikiPageRecord[],
) {
    const [links, refs] = pages.length > 0
        ? await Promise.all([
            db
                .select()
                .from(knowledgeBaseWikiLinks)
                .where(and(eq(knowledgeBaseWikiLinks.userId, userId), eq(knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId))),
            db
                .select()
                .from(knowledgeBaseWikiSourceRefs)
                .where(inArray(knowledgeBaseWikiSourceRefs.pageId, pages.map((page) => page.id))),
        ])
        : [[], []]
    const pageKeys = new Set(pages.map((page) => page.pageKey))
    const linkedFrom = new Map<string, number>()
    for (const link of links) {
        linkedFrom.set(link.toPageKey, (linkedFrom.get(link.toPageKey) ?? 0) + 1)
    }

    const issues = [
        ...pages
            .filter((page) => page.kind !== "index" && !refs.some((ref) => ref.pageId === page.id))
            .map((page) => ({
                severity: "warning" as const,
                code: "missing_source",
                pageKey: page.pageKey,
                title: page.title,
                message: "页面缺少来源引用",
            })),
        ...links
            .filter((link) => !pageKeys.has(link.toPageKey))
            .map((link) => ({
                severity: "error" as const,
                code: "broken_link",
                pageKey: link.toPageKey,
                title: link.toPageKey,
                message: "链接指向不存在的 Wiki 页面",
            })),
        ...pages
            .filter((page) => page.kind !== "index" && !linkedFrom.has(page.pageKey))
            .slice(0, 20)
            .map((page) => ({
                severity: "info" as const,
                code: "orphan_page",
                pageKey: page.pageKey,
                title: page.title,
                message: "页面暂时没有被其他页面引用",
            })),
    ]

    const score = Math.max(0, 100 - issues.filter((issue) => issue.severity === "error").length * 25 - issues.filter((issue) => issue.severity === "warning").length * 8)
    return {
        score,
        pageCount: pages.length,
        linkCount: links.length,
        sourceRefCount: refs.length,
        issueCount: issues.length,
        issues,
        checkedAt: new Date().toISOString(),
    }
}

export async function searchWikiPagesForAgent(input: {
    userId: number
    knowledgeBaseId: number
    query: string
    limit?: number
}) {
    const pages = await listWikiPagesRaw(input.userId, input.knowledgeBaseId)
    const query = input.query.trim()
    const ranked = pages
        .map((page) => ({
            page,
            score: scoreWikiPage(page, query),
        }))
        .filter((item) => item.score > 0 || !query)
        .sort((left, right) => right.score - left.score || right.page.updatedAt.getTime() - left.page.updatedAt.getTime())
        .slice(0, input.limit ?? 8)

    return ranked.map((item) => {
        const articleId = extractArticleIdFromPageKey(item.page.pageKey)
        return {
            pageKey: item.page.pageKey,
            articleId,
            href: sourceArticleHref(input.knowledgeBaseId, articleId),
            title: item.page.title,
            kind: item.page.kind,
            summary: item.page.summary || summarizePlainText(item.page.contentMd, 180),
            updatedAt: formatDate(item.page.updatedAt),
        }
    })
}

export async function readWikiPageForAgent(userId: number, knowledgeBaseId: number, pageKey: string) {
    const detail = await loadWikiPageDetail(userId, knowledgeBaseId, pageKey)
    const sourceArticleIds = detail.sourceRefs
        .map((ref) => Number(ref.articleId))
        .filter((id) => Number.isInteger(id) && id > 0)
    const media = mergeAgentImageReferences([
        ...extractAgentImageReferences(detail.contentMd),
        ...await loadArticleImageReferences(userId, knowledgeBaseId, sourceArticleIds),
    ])
    return {
        knowledgeBaseId: String(knowledgeBaseId),
        pageKey: detail.pageKey,
        articleId: extractArticleIdFromPageKey(detail.pageKey),
        href: sourceArticleHref(knowledgeBaseId, extractArticleIdFromPageKey(detail.pageKey)),
        title: detail.title,
        kind: detail.kind,
        contentMd: detail.contentMd,
        media,
        sourceRefs: detail.sourceRefs,
        links: detail.links,
    }
}

export async function readSourceArticleForAgent(userId: number, knowledgeBaseId: number, articleId: number) {
    const [article] = await getDb()
        .select()
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.id, articleId),
            eq(knowledgeBaseArticles.userId, userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBaseId),
        ))
        .limit(1)
    if (!article) {
        throw notFound("源文档不存在")
    }
    return {
        knowledgeBaseId: String(knowledgeBaseId),
        articleId: String(article.id),
        href: knowledgeBaseArticlePath(String(knowledgeBaseId), String(article.id)),
        title: article.title,
        contentMd: article.contentMd,
        media: extractAgentImageReferences(article.contentMd, {
            sourceArticleId: String(article.id),
            sourceArticleTitle: article.title,
        }),
        updatedAt: formatDate(article.updatedAt),
    }
}

// 各类媒体的扩展名归类——决定渲染层用 <img>/<video>/<audio>/<file> 中的哪一个。
const MEDIA_EXTENSION_PATTERNS: Record<AgentMediaKind, RegExp> = {
    image: /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#].*)?$/i,
    video: /\.(?:mp4|webm|ogv|mov|m4v|mkv)(?:[?#].*)?$/i,
    audio: /\.(?:mp3|wav|m4a|aac|flac|ogg|oga)(?:[?#].*)?$/i,
    file: /\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|md|zip|rar|7z|json)(?:[?#].*)?$/i,
}
// image/video/audio 走扩展名识别；其余存储对象一律兜底为可下载附件（file）。
const MEDIA_EXTENSION_ORDER: AgentMediaKind[] = ["image", "video", "audio", "file"]

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]\n]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
// 普通 Markdown 链接（排除图片语法 ![]()），用于附件/视频下载链接。
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]\n]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
// 编辑器上传的图片/视频/附件以 <img>/<video>/<audio>/<file ... src="s4key:..."> 形式入库。
const HTML_MEDIA_PATTERN = /<(?:img|video|audio|source|file)\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi
const HTML_ANCHOR_PATTERN = /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>/gi
// 裸存储路径：uploads/<id>/<对象> + 任意扩展名（含 .icls 等自定义附件）。
const RAW_STORAGE_MEDIA_PATTERN = /(?:s4key:)?\/?uploads\/\d+\/[^\s"'<>()[\]{}]+?\.[A-Za-z0-9]{1,12}(?:[?#][^\s"'<>()[\]{}]*)?/g

/** 仅按扩展名识别 image/video/audio/file；无法识别返回 null。 */
function classifyMediaExtension(path: string): AgentMediaKind | null {
    for (const kind of MEDIA_EXTENSION_ORDER) {
        if (MEDIA_EXTENSION_PATTERNS[kind].test(path)) return kind
    }
    return null
}

/** 按媒体类型分配稳定 id（image-1 / video-1 / file-1 …），同类内自增。 */
function makeMediaIdAssigner() {
    const counters: Record<AgentMediaKind, number> = { image: 0, video: 0, audio: 0, file: 0 }
    return (kind: AgentMediaKind) => `${kind}-${(counters[kind] += 1)}`
}

/** 从 HTML 标签中按优先级取第一个非空属性值（如 <file name> 的真实文件名）。 */
function extractHtmlAttr(rawTag: string | undefined, attrNames: string[]): string | undefined {
    if (!rawTag) return undefined
    for (const attr of attrNames) {
        const match = rawTag.match(new RegExp(`\\b${attr}=(["'])(.*?)\\1`, "i"))
        const value = match?.[2]?.trim()
        if (value) return value
    }
    return undefined
}

export function extractAgentImageReferences(
    markdown: string | null | undefined,
    source?: { sourceArticleId?: string; sourceArticleTitle?: string },
): AgentImageReference[] {
    if (!markdown?.trim()) return []
    const refs: AgentImageReference[] = []
    const seen = new Set<string>()
    const assignId = makeMediaIdAssigner()

    function add(rawSrc: string | undefined, opts?: { label?: string; filename?: string }) {
        const normalized = normalizeAgentMediaSource(rawSrc)
        if (!normalized) return
        const key = normalized.objectKey ?? normalized.src
        if (seen.has(key)) return
        seen.add(key)
        // 显式文件名（如 <file name="真实名.icls">）优先于从 UUID 对象键推断的名字。
        const filename = opts?.filename?.trim() || normalized.filename
        refs.push({
            id: assignId(normalized.kind),
            kind: normalized.kind,
            alt: normalizeMediaAlt(opts?.label, filename, normalized.kind),
            src: normalized.src,
            objectKey: normalized.objectKey,
            filename,
            ...source,
        })
    }

    for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
        add(match[2], { label: match[1] })
    }

    for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) {
        add(match[2], { label: match[1] })
    }

    for (const match of markdown.matchAll(HTML_MEDIA_PATTERN)) {
        const name = extractHtmlAttr(match[0], ["name", "download", "title"])
        const alt = extractHtmlAttr(match[0], ["alt"])
        add(match[2], { label: name ?? alt, filename: name })
    }

    for (const match of markdown.matchAll(HTML_ANCHOR_PATTERN)) {
        const name = extractHtmlAttr(match[0], ["download", "title"])
        add(match[2], { label: name, filename: name })
    }

    for (const match of markdown.matchAll(RAW_STORAGE_MEDIA_PATTERN)) {
        add(match[0])
    }

    return refs.slice(0, 20)
}

async function loadArticleImageReferences(userId: number, knowledgeBaseId: number, articleIds: number[]) {
    const uniqueArticleIds = Array.from(new Set(articleIds)).slice(0, 10)
    if (uniqueArticleIds.length === 0) return []
    const rows = await getDb()
        .select({
            id: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            contentMd: knowledgeBaseArticles.contentMd,
        })
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.userId, userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBaseId),
            inArray(knowledgeBaseArticles.id, uniqueArticleIds),
        ))

    return rows.flatMap((article) => extractAgentImageReferences(article.contentMd, {
        sourceArticleId: String(article.id),
        sourceArticleTitle: article.title,
    }))
}

function mergeAgentImageReferences(refs: AgentImageReference[]) {
    const merged: AgentImageReference[] = []
    const seen = new Set<string>()
    const assignId = makeMediaIdAssigner()
    for (const ref of refs) {
        const key = ref.objectKey ?? ref.src
        if (seen.has(key)) continue
        seen.add(key)
        merged.push({ ...ref, id: assignId(ref.kind) })
    }
    return merged.slice(0, 20)
}

function normalizeAgentMediaSource(rawSrc: string | undefined) {
    const src = rawSrc?.trim().replace(/^<|>$/g, "")
    if (!src) return null

    const storageUrl = normalizeS4ObjectUrl(src)
    if (storageUrl) {
        const objectKey = normalizeS4ObjectKey(storageUrl)
        if (!objectKey) return null
        // 存储对象一律可下载：识别不出 image/video/audio 的（如 .icls）兜底为 file。
        const kind = classifyMediaExtension(objectKey) ?? "file"
        return {
            src: storageUrl,
            objectKey,
            filename: extractMediaFilename(objectKey),
            kind,
        }
    }

    const kind = classifyExternalMediaKind(src)
    if (!kind) return null
    return {
        src,
        objectKey: null,
        filename: extractMediaFilename(src),
        kind,
    }
}

function classifyExternalMediaKind(src: string): AgentMediaKind | null {
    if (/^data:image\//i.test(src)) return "image"
    if (!/^https?:\/\//i.test(src)) return null
    try {
        const url = new URL(src)
        return classifyMediaExtension(url.pathname)
    } catch {
        return null
    }
}

function extractMediaFilename(src: string) {
    const clean = src.split(/[?#]/)[0] ?? src
    const part = clean.split("/").filter(Boolean).at(-1)
    if (!part) return "附件"
    try {
        return decodeURIComponent(part)
    } catch {
        return part
    }
}

const MEDIA_KIND_FALLBACK_LABEL: Record<AgentMediaKind, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    file: "附件",
}

function normalizeMediaAlt(rawAlt: string | undefined, filename: string, kind: AgentMediaKind) {
    const alt = rawAlt?.trim()
    return alt || filename || MEDIA_KIND_FALLBACK_LABEL[kind]
}

export async function proposeWikiPatchFromAgent(input: {
    userId: number
    knowledgeBaseId: number
    threadId?: number | null
    runId?: number | null
    pageKey: string
    title: string
    proposedContentMd: string
    reason?: string | null
}) {
    const db = getDb()
    const normalizedPageKey = normalizePageKey(input.pageKey)
    const existing = await loadWikiPage(db, input.userId, input.knowledgeBaseId, normalizedPageKey)
    const operation = existing ? "UPDATE" : "CREATE"
    const diffText = buildSimpleUnifiedDiff(existing?.contentMd ?? "", input.proposedContentMd, existing?.title ?? input.title)
    const [patch] = await db
        .insert(knowledgeBaseWikiPatches)
        .values({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            threadId: input.threadId ?? null,
            runId: input.runId ?? null,
            pageKey: normalizedPageKey,
            title: input.title,
            operation,
            beforeContentMd: existing?.contentMd ?? null,
            proposedContentMd: input.proposedContentMd,
            diffText,
            reason: input.reason ?? null,
        })
        .returning()
    await logWikiEvent(db, input.userId, input.knowledgeBaseId, "PATCH_PROPOSED", existing?.id ?? null, input.threadId ?? null, {
        patchId: String(patch.id),
        pageKey: normalizedPageKey,
        operation,
    })
    return toWikiPatchResponse(patch)
}

async function loadKnowledgeBaseArticles(db: Db, userId: number, knowledgeBaseId: number, articleIds?: number[]) {
    const nodes = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(eq(knowledgeBaseNodes.userId, userId), eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId)))
    const articleFilter = articleIds?.length
        ? and(
            eq(knowledgeBaseArticles.userId, userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBaseId),
            inArray(knowledgeBaseArticles.id, articleIds),
        )
        : and(eq(knowledgeBaseArticles.userId, userId), eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBaseId))
    const articles = await db
        .select()
        .from(knowledgeBaseArticles)
        .where(articleFilter)
        .orderBy(asc(knowledgeBaseArticles.updatedAt), asc(knowledgeBaseArticles.id))
    return { nodes, articles }
}

async function generateArticleWikiDraft(input: {
    userId: number
    knowledgeBaseName: string
    article: KnowledgeBaseArticleRecord
}): Promise<ArticleWikiDraft> {
    const content = input.article.contentMd.length > 12000
        ? `${input.article.contentMd.slice(0, 12000)}\n\n[内容已截断]`
        : input.article.contentMd
    const result = await callChatCompletion({
        userId: input.userId,
        systemPrompt: [
            "你是一个文档 Wiki 编译 Agent。",
            "请把源文档编译成可长期维护的 Wiki 中间层元数据。",
            "只输出 JSON，不要输出 Markdown 围栏。",
            "JSON 字段：summary:string, keyPoints:string[], entities:string[], questions:string[]。",
        ].join("\n"),
        message: [
            `知识库：${input.knowledgeBaseName}`,
            `文档标题：${input.article.title}`,
            "文档内容：",
            content,
        ].join("\n\n"),
    })
    const parsed = safeParseJsonObject(result.answer)
    const normalized = llmArticleWikiSchema.parse(parsed)
    return {
        summary: normalized.summary?.trim() || summarizePlainText(input.article.contentMd, 240),
        keyPoints: normalizeStringList(normalized.keyPoints).slice(0, 12),
        entities: normalizeStringList(normalized.entities).slice(0, 20),
        questions: normalizeStringList(normalized.questions).slice(0, 8),
    }
}

function buildFallbackArticleWikiDraft(article: KnowledgeBaseArticleRecord): ArticleWikiDraft {
    const headings = extractMarkdownHeadings(article.contentMd)
    return {
        summary: summarizePlainText(article.contentMd, 240),
        keyPoints: headings.length > 0 ? headings.slice(0, 12) : splitSentences(article.contentMd).slice(0, 8),
        entities: [],
        questions: [
            `${article.title} 的核心结论是什么？`,
            `${article.title} 中有哪些关键概念？`,
        ],
    }
}

function renderArticleWikiPage(article: KnowledgeBaseArticleRecord, draft: ArticleWikiDraft) {
    const keyPoints = draft.keyPoints.length > 0
        ? draft.keyPoints.map((item) => `- ${item}`).join("\n")
        : "- 暂无结构化要点"
    const entities = draft.entities.length > 0
        ? draft.entities.map((item) => `\`${item}\``).join("、")
        : "暂无"
    const questions = draft.questions.length > 0
        ? draft.questions.map((item) => `- ${item}`).join("\n")
        : "- 暂无"

    return [
        `# ${article.title}`,
        "",
        "## 摘要",
        draft.summary,
        "",
        "## 关键要点",
        keyPoints,
        "",
        "## 相关实体",
        entities,
        "",
        "## 可回答的问题",
        questions,
        "",
        "## 来源",
        `- 源文档 ID：${article.id}`,
        `- 最近更新：${formatDate(article.updatedAt) ?? ""}`,
    ].join("\n")
}

async function rebuildWikiIndex(db: DbExecutor, userId: number, knowledgeBaseId: number, knowledgeBaseName: string) {
    const pages = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))
        .orderBy(asc(knowledgeBaseWikiPages.kind), asc(knowledgeBaseWikiPages.title))
    const sourcePages = pages.filter((page) => page.kind === "source")
    const conceptPages = pages.filter((page) => page.kind !== "source" && page.kind !== "index")
    const contentMd = [
        `# ${knowledgeBaseName} Wiki 索引`,
        "",
        "这个页面是文档问答 Agent 的入口。回答问题时应先读取本索引，再按需读取具体 Wiki 页面；只有 Wiki 信息不足时才回看源文档。",
        "",
        "## 源文档页面",
        ...sourcePages.map((page) => `- [[${page.pageKey}]] ${page.title}：${page.summary || summarizePlainText(page.contentMd, 120)}`),
        "",
        "## 主题与答案页面",
        ...(conceptPages.length > 0
            ? conceptPages.map((page) => `- [[${page.pageKey}]] ${page.title}：${page.summary || summarizePlainText(page.contentMd, 120)}`)
            : ["- 暂无沉淀页面"]),
        "",
        "## 维护规则",
        "- 原始文档是真源，不要静默改写。",
        "- Wiki 页面可以通过补丁审批更新。",
        "- 回答必须说明依据来自哪些 Wiki 页面或源文档。",
    ].join("\n")

    const indexPage = await upsertWikiPage(db, {
        userId,
        knowledgeBaseId,
        pageKey: "index",
        title: `${knowledgeBaseName} Wiki 索引`,
        kind: "index",
        contentMd,
        summary: `收录 ${sourcePages.length} 个源文档页面，${conceptPages.length} 个主题/答案页面。`,
        frontmatter: { sourcePageCount: sourcePages.length, conceptPageCount: conceptPages.length },
        sourceRefs: [],
    })

    await db.delete(knowledgeBaseWikiLinks).where(eq(knowledgeBaseWikiLinks.fromPageId, indexPage.id))
    const linkValues = pages
        .filter((page) => page.pageKey !== "index")
        .map((page) => ({
            userId,
            knowledgeBaseId,
            fromPageId: indexPage.id,
            toPageKey: page.pageKey,
            linkType: "index",
        }))
    if (linkValues.length > 0) {
        await db.insert(knowledgeBaseWikiLinks).values(linkValues)
    }
    return indexPage
}

async function upsertWikiPage(db: DbExecutor, input: {
    userId: number
    knowledgeBaseId: number
    pageKey: string
    title: string
    kind: WikiPageKind | string
    contentMd: string
    summary?: string | null
    frontmatter?: unknown
    sourceRefs: Array<{ articleId: number; anchor?: string | null; note?: string | null }>
}) {
    const now = new Date()
    const normalizedPageKey = normalizePageKey(input.pageKey)
    const contentHash = stableHash(input.contentMd)
    const existing = await loadWikiPage(db, input.userId, input.knowledgeBaseId, normalizedPageKey)
    const values = {
        title: input.title,
        kind: input.kind,
        contentMd: input.contentMd,
        summary: input.summary ?? null,
        frontmatterJson: input.frontmatter === undefined ? null : JSON.stringify(input.frontmatter),
        contentHash,
        archivedAt: null,
        updatedAt: now,
    }
    const [page] = existing
        ? await db
            .update(knowledgeBaseWikiPages)
            .set({ ...values, version: existing.version + 1 })
            .where(and(eq(knowledgeBaseWikiPages.id, existing.id), eq(knowledgeBaseWikiPages.userId, input.userId)))
            .returning()
        : await db
            .insert(knowledgeBaseWikiPages)
            .values({
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                pageKey: normalizedPageKey,
                ...values,
            })
            .returning()

    await db.delete(knowledgeBaseWikiSourceRefs).where(eq(knowledgeBaseWikiSourceRefs.pageId, page.id))
    if (input.sourceRefs.length > 0) {
        await db.insert(knowledgeBaseWikiSourceRefs).values(input.sourceRefs.map((ref) => ({
            pageId: page.id,
            articleId: ref.articleId,
            anchor: ref.anchor ?? null,
            note: ref.note ?? null,
            quoteHash: null,
        })))
    }
    return page
}

async function loadWikiPage(db: DbExecutor, userId: number, knowledgeBaseId: number, pageKey: string) {
    const [page] = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseWikiPages.pageKey, normalizePageKey(pageKey)),
        ))
        .limit(1)
    return page ?? null
}

async function listWikiPagesRaw(userId: number, knowledgeBaseId: number) {
    await assertKnowledgeBaseOwner(getDb(), userId, knowledgeBaseId)
    return await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(eq(knowledgeBaseWikiPages.userId, userId), eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId)))
        .orderBy(desc(knowledgeBaseWikiPages.updatedAt))
}

async function loadPatch(db: Db, userId: number, knowledgeBaseId: number, patchId: number) {
    const [patch] = await db
        .select()
        .from(knowledgeBaseWikiPatches)
        .where(and(
            eq(knowledgeBaseWikiPatches.id, patchId),
            eq(knowledgeBaseWikiPatches.userId, userId),
            eq(knowledgeBaseWikiPatches.knowledgeBaseId, knowledgeBaseId),
        ))
        .limit(1)
    if (!patch) {
        throw notFound("Wiki 补丁不存在")
    }
    return patch
}

async function logWikiEvent(db: Db, userId: number, knowledgeBaseId: number, eventType: string, pageId: number | null, threadId: number | null, payload: unknown) {
    await db.insert(knowledgeBaseWikiEventLogs).values({
        userId,
        knowledgeBaseId,
        eventType,
        pageId,
        threadId,
        payloadJson: JSON.stringify(payload),
    })
}

type KnowledgePageContribution = {
    articleId: string
    articleTitle: string
    summary: string
    contentMd: string
    aliases: string[]
    categoryPath: string[]
    sourceChunkKeys: string[]
    relatedPageKeys: string[]
    relations: ExtractedKnowledgeRelation[]
}

type KnowledgePageMetadata = {
    generatedBy: string | null
    buildVersion: number
    sourceHash: string | null
    chunkCount: number
    entityCount: number
    conceptCount: number
    categoryPath: string[]
    aliases: string[]
    baseContentMd: string | null
    baseSummary: string | null
    contributions: Record<string, KnowledgePageContribution>
}

function readKnowledgePageMetadata(raw: string | null | undefined): KnowledgePageMetadata {
    const parsed = parseJsonObject(raw)
    const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    const rawContributions = value.contributions && typeof value.contributions === "object" && !Array.isArray(value.contributions)
        ? value.contributions as Record<string, unknown>
        : {}
    const contributions: Record<string, KnowledgePageContribution> = {}
    for (const [articleId, rawContribution] of Object.entries(rawContributions)) {
        if (!rawContribution || typeof rawContribution !== "object" || Array.isArray(rawContribution)) continue
        const contribution = rawContribution as Record<string, unknown>
        contributions[articleId] = {
            articleId,
            articleTitle: typeof contribution.articleTitle === "string" ? contribution.articleTitle : `文章 ${articleId}`,
            summary: typeof contribution.summary === "string" ? contribution.summary : "",
            contentMd: typeof contribution.contentMd === "string" ? contribution.contentMd : "",
            aliases: normalizeStringList(contribution.aliases),
            categoryPath: normalizeStringList(contribution.categoryPath).slice(0, 2),
            sourceChunkKeys: normalizeStringList(contribution.sourceChunkKeys),
            relatedPageKeys: normalizeStringList(contribution.relatedPageKeys),
            relations: normalizeStoredKnowledgeRelations(contribution.relations),
        }
    }
    return {
        generatedBy: typeof value.generatedBy === "string" ? value.generatedBy : null,
        buildVersion: typeof value.buildVersion === "number" ? value.buildVersion : 0,
        sourceHash: typeof value.sourceHash === "string" ? value.sourceHash : null,
        chunkCount: typeof value.chunkCount === "number" ? value.chunkCount : 0,
        entityCount: typeof value.entityCount === "number" ? value.entityCount : 0,
        conceptCount: typeof value.conceptCount === "number" ? value.conceptCount : 0,
        categoryPath: normalizeStringList(value.categoryPath).slice(0, 2),
        aliases: normalizeStringList(value.aliases),
        baseContentMd: typeof value.baseContentMd === "string" && value.baseContentMd.trim() ? value.baseContentMd : null,
        baseSummary: typeof value.baseSummary === "string" && value.baseSummary.trim() ? value.baseSummary : null,
        contributions,
    }
}

function normalizeStoredKnowledgeRelations(value: unknown): ExtractedKnowledgeRelation[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const relations: ExtractedKnowledgeRelation[] = []
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue
        const relation = item as Record<string, unknown>
        const fromPageKey = typeof relation.fromPageKey === "string"
            ? normalizePageKey(relation.fromPageKey)
            : ""
        const toPageKey = typeof relation.toPageKey === "string"
            ? normalizePageKey(relation.toPageKey)
            : ""
        if (!fromPageKey || !toPageKey || fromPageKey === toPageKey) continue
        const relationType = typeof relation.relationType === "string" && relation.relationType.trim()
            ? relation.relationType.trim().slice(0, 60)
            : "关联"
        const description = typeof relation.description === "string"
            ? relation.description.trim().slice(0, 300)
            : ""
        const key = `${fromPageKey}|${toPageKey}|${relationType}`
        if (seen.has(key)) continue
        seen.add(key)
        relations.push({ fromPageKey, toPageKey, relationType, description })
    }
    return relations
}

function collectKnowledgePageRelations(metadata: KnowledgePageMetadata) {
    const ownPageRelations = Object.values(metadata.contributions)
        .flatMap((contribution) => contribution.relations)
    return normalizeStoredKnowledgeRelations(ownPageRelations)
}

function buildArticleKnowledgeResponse(input: {
    article: KnowledgeBaseArticleRecord
    sourcePage: KnowledgeBaseWikiPageRecord
    fromCache: boolean
    chunkCount: number
    entityCount: number
    conceptCount: number
    warnings: string[]
}) {
    return {
        articleId: String(input.article.id),
        knowledgeBaseId: String(input.article.knowledgeBaseId),
        fromCache: input.fromCache,
        chunkCount: input.chunkCount,
        recommendedQuestionCount: input.chunkCount * 3,
        entityCount: input.entityCount,
        conceptCount: input.conceptCount,
        sourcePage: toWikiPageResponse(input.sourcePage),
        warnings: input.warnings,
    }
}

async function detachArticleFromGeneratedKnowledgePages(
    db: DbExecutor,
    input: { userId: number; knowledgeBaseId: number; articleId: number },
) {
    const pages = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, input.userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, input.knowledgeBaseId),
            or(eq(knowledgeBaseWikiPages.kind, "entity"), eq(knowledgeBaseWikiPages.kind, "concept")),
        ))
    const articleId = String(input.articleId)
    for (const page of pages) {
        const metadata = readKnowledgePageMetadata(page.frontmatterJson)
        if (metadata.generatedBy !== "article-knowledge-build" || !metadata.contributions[articleId]) continue
        delete metadata.contributions[articleId]
        const remaining = Object.values(metadata.contributions)
        if (remaining.length === 0 && !metadata.baseContentMd) {
            await deleteWikiPageByKey(db, {
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                pageKey: page.pageKey,
            })
            continue
        }
        const updatedPage = await upsertWikiPage(db, {
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            pageKey: page.pageKey,
            title: page.title,
            kind: page.kind,
            contentMd: renderAggregatedKnowledgePage(page.title, metadata),
            summary: metadata.baseSummary ?? remaining[0]?.summary ?? page.summary,
            frontmatter: metadata,
            sourceRefs: remaining.map((contribution) => ({
                articleId: Number(contribution.articleId),
                note: `构建知识：${contribution.articleTitle}`,
            })),
        })
        await replaceGeneratedKnowledgePageLinks(db, updatedPage, metadata)
    }
}

/**
 * 物理删除单个 Wiki 页面及其派生数据，兼容本地 SQLite 没有外键级联的测试环境。
 * 事件日志继续作为审计记录保留，但会解除对旧页面行的引用。
 */
async function deleteWikiPageByKey(
    db: DbExecutor,
    input: { userId: number; knowledgeBaseId: number; pageKey: string },
) {
    const page = await loadWikiPage(db, input.userId, input.knowledgeBaseId, input.pageKey)
    if (!page) return false

    await db
        .update(knowledgeBaseWikiEventLogs)
        .set({ pageId: null })
        .where(eq(knowledgeBaseWikiEventLogs.pageId, page.id))
    await db
        .delete(knowledgeBaseWikiLinks)
        .where(and(
            eq(knowledgeBaseWikiLinks.userId, input.userId),
            eq(knowledgeBaseWikiLinks.knowledgeBaseId, input.knowledgeBaseId),
            or(
                eq(knowledgeBaseWikiLinks.fromPageId, page.id),
                eq(knowledgeBaseWikiLinks.toPageKey, page.pageKey),
            ),
        ))
    await db
        .delete(knowledgeBaseWikiSourceRefs)
        .where(eq(knowledgeBaseWikiSourceRefs.pageId, page.id))
    await db
        .delete(knowledgeBaseWikiTreeNodes)
        .where(eq(knowledgeBaseWikiTreeNodes.pageId, page.id))
    await db
        .delete(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.id, page.id),
            eq(knowledgeBaseWikiPages.userId, input.userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, input.knowledgeBaseId),
        ))
    return true
}

async function upsertExtractedKnowledgePage(db: DbExecutor, input: {
    userId: number
    knowledgeBaseId: number
    article: KnowledgeBaseArticleRecord
    item: ExtractedKnowledgeItem
}) {
    const existing = await loadWikiPage(db, input.userId, input.knowledgeBaseId, input.item.pageKey)
    const previous = readKnowledgePageMetadata(existing?.frontmatterJson)
    const ownsExisting = previous.generatedBy === "article-knowledge-build"
    const contributions = ownsExisting ? previous.contributions : {}
    contributions[String(input.article.id)] = {
        articleId: String(input.article.id),
        articleTitle: input.article.title,
        summary: input.item.summary,
        contentMd: input.item.contentMd,
        aliases: input.item.aliases,
        categoryPath: input.item.categoryPath,
        sourceChunkKeys: [],
        relatedPageKeys: input.item.relatedPageKeys,
        relations: input.item.relations,
    }
    const metadata: KnowledgePageMetadata = {
        generatedBy: "article-knowledge-build",
        buildVersion: ARTICLE_KNOWLEDGE_BUILD_VERSION,
        sourceHash: null,
        chunkCount: 0,
        entityCount: 0,
        conceptCount: 0,
        categoryPath: previous.buildVersion >= ARTICLE_KNOWLEDGE_BUILD_VERSION && previous.categoryPath.length > 0
            ? previous.categoryPath
            : input.item.categoryPath.length > 0
                ? input.item.categoryPath
                : previous.categoryPath,
        aliases: [...new Set([...previous.aliases, ...input.item.aliases])].slice(0, 20),
        baseContentMd: ownsExisting ? previous.baseContentMd : existing?.contentMd ?? null,
        baseSummary: ownsExisting ? previous.baseSummary : existing?.summary ?? null,
        contributions,
    }
    const contributionValues = Object.values(contributions)
    const page = await upsertWikiPage(db, {
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        pageKey: input.item.pageKey,
        title: input.item.name,
        kind: input.item.kind,
        contentMd: renderAggregatedKnowledgePage(input.item.name, metadata),
        summary: input.item.summary || metadata.baseSummary,
        frontmatter: metadata,
        sourceRefs: contributionValues.map((contribution) => ({
            articleId: Number(contribution.articleId),
            note: `构建知识：${contribution.articleTitle}`,
        })),
    })
    await replaceGeneratedKnowledgePageLinks(db, page, metadata)
    return page
}

function renderAggregatedKnowledgePage(title: string, metadata: KnowledgePageMetadata) {
    const contributions = Object.values(metadata.contributions)
    const bodies = [
        ...(metadata.baseContentMd ? [metadata.baseContentMd] : []),
        ...contributions.map((contribution) => contribution.contentMd || contribution.summary),
    ].filter((value): value is string => Boolean(value?.trim()))
    if (bodies.length === 0) return `# ${title}\n\n暂无文章构建结果。`
    if (bodies.length === 1 && !metadata.baseContentMd) return ensureWikiPageTitle(bodies[0], title)

    const seen = new Set<string>()
    const blocks: string[] = []
    for (const body of bodies) {
        const withoutTitle = stripLeadingWikiTitle(body, title)
        for (const block of withoutTitle.split(/\n{2,}/)) {
            const normalized = block.replace(/\s+/g, " ").trim().toLowerCase()
            if (!normalized || seen.has(normalized)) continue
            seen.add(normalized)
            blocks.push(block.trim())
        }
    }
    return [`# ${title}`, "", ...blocks].join("\n\n").trim()
}

function ensureWikiPageTitle(contentMd: string, title: string) {
    const content = contentMd.trim()
    return /^#\s+/m.test(content) ? content : `# ${title}\n\n${content}`
}

function stripLeadingWikiTitle(contentMd: string, title: string) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return contentMd
        .trim()
        .replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "i"), "")
        .replace(/^#\s+[^\n]+\n+/, "")
        .trim()
}

async function replaceGeneratedKnowledgePageLinks(
    db: DbExecutor,
    page: KnowledgeBaseWikiPageRecord,
    metadata: KnowledgePageMetadata,
) {
    await db.delete(knowledgeBaseWikiLinks).where(eq(knowledgeBaseWikiLinks.fromPageId, page.id))
    const relations = collectKnowledgePageRelations(metadata)
        .filter((relation) => relation.fromPageKey === page.pageKey && relation.toPageKey !== page.pageKey)
    if (relations.length === 0) return
    await db.insert(knowledgeBaseWikiLinks).values(relations.map((relation) => ({
        userId: page.userId,
        knowledgeBaseId: page.knowledgeBaseId,
        fromPageId: page.id,
        toPageKey: relation.toPageKey,
        linkType: relation.relationType,
    })))
}

async function rebuildGeneratedKnowledgePageLinks(
    db: DbExecutor,
    userId: number,
    knowledgeBaseId: number,
) {
    const pages = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, userId),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            or(eq(knowledgeBaseWikiPages.kind, "entity"), eq(knowledgeBaseWikiPages.kind, "concept")),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))
    if (pages.length === 0) return

    await db.delete(knowledgeBaseWikiLinks).where(inArray(
        knowledgeBaseWikiLinks.fromPageId,
        pages.map((page) => page.id),
    ))
    const activePageKeys = new Set(pages.map((page) => page.pageKey))
    const values = pages.flatMap((page) => (
        collectKnowledgePageRelations(readKnowledgePageMetadata(page.frontmatterJson))
            .filter((relation) => (
                relation.fromPageKey === page.pageKey
                && activePageKeys.has(relation.toPageKey)
                && relation.toPageKey !== page.pageKey
            ))
            .map((relation) => ({
                userId,
                knowledgeBaseId,
                fromPageId: page.id,
                toPageKey: relation.toPageKey,
                linkType: relation.relationType,
            }))
    ))
    if (values.length > 0) await db.insert(knowledgeBaseWikiLinks).values(values)
}

function renderBuiltSourcePage(article: KnowledgeBaseArticleRecord, result: KnowledgeBuildWorkflowResult) {
    const entities = result.items.filter((item) => item.kind === "entity")
    const concepts = result.items.filter((item) => item.kind === "concept")
    return [
        `# ${article.title}`,
        "",
        "## 文档摘要",
        result.documentSummary || "暂无摘要。",
        "",
        "## 实体",
        ...(entities.length > 0
            ? entities.map((item) => `- [[${item.pageKey}|${item.name}]]：${item.summary}`)
            : ["- 未抽取到实体"]),
        "",
        "## 概念",
        ...(concepts.length > 0
            ? concepts.map((item) => `- [[${item.pageKey}|${item.name}]]：${item.summary}`)
            : ["- 未抽取到概念"]),
        "",
        "## 知识关系",
        ...(result.relations.length > 0
            ? result.relations.map((relation) => (
                `- [[${relation.fromPageKey}|${relation.fromPageKey}]] ${relation.relationType} `
                + `[[${relation.toPageKey}|${relation.toPageKey}]]${relation.description ? `：${relation.description}` : ""}`
            ))
            : ["- 未抽取到有明确原文依据的关系"]),
        "",
        "## 切片推荐问题",
        ...result.chunks.flatMap((chunk) => [
            `### ${chunk.heading}`,
            ...chunk.recommendedQuestions.map((question) => `- ${question}`),
            "",
        ]),
        "## 来源",
        `- 源文档 ID：${article.id}`,
        `- 最近更新：${formatDate(article.updatedAt) ?? ""}`,
    ].join("\n")
}

function buildArticleSourcePageKey(articleId: number) {
    return `source-${articleId}`
}

function parseJsonObject(raw: string | null | undefined) {
    if (!raw?.trim()) return null
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return null
    }
}

/** 存量 source 页没有该字段，按 0 处理，从而被判定为过期并引导重建 */
function getFrontmatterChunkAlgorithmVersion(page: KnowledgeBaseWikiPageRecord) {
    const frontmatter = parseJsonObject(page.frontmatterJson)
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return 0
    const value = (frontmatter as { chunkAlgorithmVersion?: unknown }).chunkAlgorithmVersion
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function getFrontmatterSourceHash(page: KnowledgeBaseWikiPageRecord) {
    const frontmatter = parseJsonObject(page.frontmatterJson)
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
        return null
    }
    const value = (frontmatter as { sourceHash?: unknown }).sourceHash
    return typeof value === "string" ? value : null
}

function safeParseJsonObject(raw: string) {
    const jsonText = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
    const start = jsonText.indexOf("{")
    const end = jsonText.lastIndexOf("}")
    if (start < 0 || end < start) {
        throw badRequest("模型没有返回合法 JSON")
    }
    return JSON.parse(jsonText.slice(start, end + 1)) as unknown
}

function normalizeStringList(values: unknown) {
    if (!Array.isArray(values)) return []
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
}

function summarizePlainText(markdown: string, maxLength: number) {
    const text = markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
        .replace(/\[[^\]]*]\([^)]*\)/g, (value) => value.replace(/^\[|\]\([^)]*\)$/g, ""))
        .replace(/[#>*_\-~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (text.length <= maxLength) return text
    return `${text.slice(0, maxLength).trim()}...`
}

function extractMarkdownHeadings(markdown: string) {
    return markdown
        .split(/\r?\n/)
        .map((line) => line.match(/^#{1,4}\s+(.+)$/)?.[1]?.trim())
        .filter((value): value is string => Boolean(value))
}

function splitSentences(markdown: string) {
    return summarizePlainText(markdown, 1200)
        .split(/[。！？.!?]\s*/)
        .map((item) => item.trim())
        .filter(Boolean)
}

function scoreWikiPage(page: KnowledgeBaseWikiPageRecord, query: string) {
    return scoreSearchFields({
        title: page.title,
        summary: page.summary,
        content: page.contentMd,
        extra: page.pageKey,
    }, query)
}

function buildSimpleUnifiedDiff(oldText: string, newText: string, title: string) {
    const oldLines = oldText.split(/\r?\n/)
    const newLines = newText.split(/\r?\n/)
    const lines = [
        `--- ${title || "before"}`,
        `+++ ${title || "after"}`,
    ]
    const max = Math.max(oldLines.length, newLines.length)
    for (let index = 0; index < max; index += 1) {
        const before = oldLines[index]
        const after = newLines[index]
        if (before === after) {
            if (before !== undefined) lines.push(` ${before}`)
            continue
        }
        if (before !== undefined) lines.push(`-${before}`)
        if (after !== undefined) lines.push(`+${after}`)
    }
    return lines.join("\n")
}
