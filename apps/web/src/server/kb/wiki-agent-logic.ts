import { createHash } from "node:crypto"
import { and, asc, desc, eq, inArray, isNull, like, or } from "drizzle-orm"
import { z } from "zod"
import { callChatCompletion } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseAgentArtifacts,
    knowledgeBaseAgentMessages,
    knowledgeBaseAgentRuns,
    knowledgeBaseAgentSteps,
    knowledgeBaseAgentThreads,
    knowledgeBaseArticles,
    knowledgeBaseNodes,
    knowledgeBases,
    knowledgeBaseWikiEventLogs,
    knowledgeBaseWikiLinks,
    knowledgeBaseWikiPages,
    knowledgeBaseWikiPatches,
    knowledgeBaseWikiSourceRefs,
    type KnowledgeBaseAgentArtifactRecord,
    type KnowledgeBaseAgentThreadRecord,
    type KnowledgeBaseArticleRecord,
    type KnowledgeBaseRecord,
    type KnowledgeBaseWikiPageRecord,
    type KnowledgeBaseWikiPatchRecord,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"

type Db = ReturnType<typeof getDb>

export type WikiPageKind = "index" | "source" | "concept" | "entity" | "comparison" | "answer" | "log"
export type WikiPatchStatus = "PENDING" | "APPLIED" | "REJECTED"

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
})

export const wikiPageDetailInputSchema = knowledgeBaseIdInputSchema.extend({
    pageKey: z.string().trim().min(1).max(200),
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
    return {
        id: String(page.id),
        knowledgeBaseId: String(page.knowledgeBaseId),
        pageKey: page.pageKey,
        title: page.title,
        kind: page.kind as WikiPageKind,
        contentMd: page.contentMd,
        frontmatter: parseJsonObject(page.frontmatterJson),
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
    const pages = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(eq(knowledgeBaseWikiPages.userId, userId), eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId)))
        .orderBy(asc(knowledgeBaseWikiPages.kind), asc(knowledgeBaseWikiPages.title))

    return pages.map(toWikiPageResponse)
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

    const links = await db
        .select()
        .from(knowledgeBaseWikiLinks)
        .where(eq(knowledgeBaseWikiLinks.fromPageId, page.id))
        .orderBy(asc(knowledgeBaseWikiLinks.toPageKey))

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
            linkType: link.linkType,
        })),
    }
}

export async function loadWikiDashboard(userId: number, knowledgeBaseId: number) {
    const db = getDb()
    await assertKnowledgeBaseOwner(db, userId, knowledgeBaseId)
    const [kb] = await db
        .select()
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, userId)))
        .limit(1)
    const pages = await listWikiPages(userId, knowledgeBaseId)
    const threads = await listAgentThreads(userId, knowledgeBaseId)
    const patches = await listWikiPatches(userId, knowledgeBaseId, "PENDING")
    const lint = await runWikiLint(userId, knowledgeBaseId)
    const artifacts = await listAgentArtifacts(userId, knowledgeBaseId)

    return {
        knowledgeBase: kb ? toKnowledgeBaseLite(kb) : null,
        pages,
        threads,
        pendingPatches: patches,
        lint,
        artifacts,
    }
}

export async function ingestKnowledgeBaseWiki(input: {
    userId: number
    knowledgeBaseId: number
    articleIds?: number[]
    forceRebuild?: boolean
}) {
    const db = getDb()
    const kb = await assertKnowledgeBaseOwner(db, input.userId, input.knowledgeBaseId)
    const graph = await loadKnowledgeBaseArticles(db, input.userId, input.knowledgeBaseId, input.articleIds)
    if (graph.articles.length === 0) {
        throw badRequest("知识库里还没有可编译的文章")
    }

    const pages: KnowledgeBaseWikiPageRecord[] = []
    const warnings: string[] = []
    for (const article of graph.articles) {
        const sourceHash = stableHash(`${article.title}\n${article.contentMd}`)
        const pageKey = buildArticleSourcePageKey(article.id)
        const existing = await loadWikiPage(db, input.userId, input.knowledgeBaseId, pageKey)
        if (existing && getFrontmatterSourceHash(existing) === sourceHash && !input.forceRebuild) {
            pages.push(existing)
            continue
        }

        const draft = await generateArticleWikiDraft({
            userId: input.userId,
            knowledgeBaseName: kb.name,
            article,
        }).catch((error: unknown) => {
            warnings.push(error instanceof Error ? error.message : "模型编译失败，已使用本地摘要策略")
            return buildFallbackArticleWikiDraft(article)
        })
        const contentMd = renderArticleWikiPage(article, draft)
        const page = await upsertWikiPage(db, {
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
        pages.push(page)
    }

    const indexPage = await rebuildWikiIndex(db, input.userId, input.knowledgeBaseId, kb.name)
    await logWikiEvent(db, input.userId, input.knowledgeBaseId, "INGEST", indexPage.id, null, {
        articleCount: graph.articles.length,
        pageCount: pages.length + 1,
        warnings,
    })

    return {
        knowledgeBaseId: String(input.knowledgeBaseId),
        indexPage: toWikiPageResponse(indexPage),
        pages: pages.map(toWikiPageResponse),
        warnings: [...new Set(warnings)].slice(0, 5),
    }
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
        .orderBy(desc(knowledgeBaseAgentThreads.updatedAt))
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
        .orderBy(asc(knowledgeBaseAgentMessages.createdAt))
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
    const rows = await db
        .select({
            page: knowledgeBaseWikiPages,
            kbName: knowledgeBases.name,
        })
        .from(knowledgeBaseWikiPages)
        .innerJoin(knowledgeBases, eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBases.id))
        .where(eq(knowledgeBaseWikiPages.userId, input.userId))
        .orderBy(desc(knowledgeBaseWikiPages.updatedAt))
        .limit(500)

    const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const ranked = rows
        .map(({ page, kbName }) => ({
            page,
            kbName,
            score: scoreWikiPage(page, terms),
        }))
        .filter((item) => item.score > 0 || terms.length === 0)
        .sort((left, right) => right.score - left.score || right.page.updatedAt.getTime() - left.page.updatedAt.getTime())
        .slice(0, input.limit ?? 10)

    return ranked.map((item) => ({
        knowledgeBaseId: String(item.page.knowledgeBaseId),
        knowledgeBaseName: item.kbName,
        pageKey: item.page.pageKey,
        articleId: extractArticleIdFromPageKey(item.page.pageKey),
        title: item.page.title,
        kind: item.page.kind,
        summary: item.page.summary || summarizePlainText(item.page.contentMd, 180),
        updatedAt: formatDate(item.page.updatedAt),
    }))
}

function extractArticleIdFromPageKey(pageKey: string): string | null {
    const match = pageKey.match(/^source-(\d+)$/)
    return match ? match[1] : null
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
    const pages = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(eq(knowledgeBaseWikiPages.userId, userId), eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId)))
        .orderBy(asc(knowledgeBaseWikiPages.kind), asc(knowledgeBaseWikiPages.title))
    const links = pages.length > 0
        ? await db
            .select()
            .from(knowledgeBaseWikiLinks)
            .where(and(eq(knowledgeBaseWikiLinks.userId, userId), eq(knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId)))
        : []
    const refs = pages.length > 0
        ? await db
            .select()
            .from(knowledgeBaseWikiSourceRefs)
            .where(inArray(knowledgeBaseWikiSourceRefs.pageId, pages.map((page) => page.id)))
        : []
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
    const terms = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const ranked = pages
        .map((page) => ({
            page,
            score: scoreWikiPage(page, terms),
        }))
        .filter((item) => item.score > 0 || terms.length === 0)
        .sort((left, right) => right.score - left.score || right.page.updatedAt.getTime() - left.page.updatedAt.getTime())
        .slice(0, input.limit ?? 8)

    return ranked.map((item) => ({
        pageKey: item.page.pageKey,
        articleId: extractArticleIdFromPageKey(item.page.pageKey),
        title: item.page.title,
        kind: item.page.kind,
        summary: item.page.summary || summarizePlainText(item.page.contentMd, 180),
        updatedAt: formatDate(item.page.updatedAt),
    }))
}

export async function readWikiPageForAgent(userId: number, knowledgeBaseId: number, pageKey: string) {
    const detail = await loadWikiPageDetail(userId, knowledgeBaseId, pageKey)
    return {
        knowledgeBaseId: String(knowledgeBaseId),
        pageKey: detail.pageKey,
        articleId: extractArticleIdFromPageKey(detail.pageKey),
        title: detail.title,
        kind: detail.kind,
        contentMd: detail.contentMd,
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
        articleId: String(article.id),
        title: article.title,
        contentMd: article.contentMd,
        updatedAt: formatDate(article.updatedAt),
    }
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

async function rebuildWikiIndex(db: Db, userId: number, knowledgeBaseId: number, knowledgeBaseName: string) {
    const pages = await db
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(eq(knowledgeBaseWikiPages.userId, userId), eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId)))
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

async function upsertWikiPage(db: Db, input: {
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

async function loadWikiPage(db: Db, userId: number, knowledgeBaseId: number, pageKey: string) {
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

function buildArticleSourcePageKey(articleId: number) {
    return `source-${articleId}`
}

function toKnowledgeBaseLite(kb: KnowledgeBaseRecord) {
    return {
        id: String(kb.id),
        name: kb.name,
        description: kb.description,
        createdAt: formatDate(kb.createdAt),
        updatedAt: formatDate(kb.updatedAt),
    }
}

function parseJsonObject(raw: string | null | undefined) {
    if (!raw?.trim()) return null
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return null
    }
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

function scoreWikiPage(page: KnowledgeBaseWikiPageRecord, terms: string[]) {
    if (terms.length === 0) return 1
    const haystack = `${page.title}\n${page.pageKey}\n${page.summary ?? ""}\n${page.contentMd}`.toLowerCase()
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
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
