import { randomBytes } from "node:crypto"
import { after, type NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, type SQL } from "drizzle-orm"
import { z } from "zod"
import { callChatCompletion } from "@/server/ai/generation"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    agentCallLogs,
    agentApiKeys,
    knowledgeBaseArticles,
    knowledgeBaseArticleShares,
    knowledgeBaseArticleTags,
    knowledgeBaseNodes,
    knowledgeBases,
    type KnowledgeBaseArticleRecord,
    type KnowledgeBaseArticleShareRecord,
} from "@/server/db/schema"
import { badRequest, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import { buildArticlePath, buildPublicArticleMetadata, buildPublicShareRepostAttribution } from "@/server/kb/share-logic"
import {
    buildArticleAiSummaryContentHash,
    buildArticleSummarySystemPrompt,
    buildArticleSummaryUserMessage,
    isArticleAiSummaryCacheHit,
    normalizeArticleSummaryModelOutput,
} from "@/server/kb/article-summary-logic"
import {
    buildMindmapContentHash,
    buildMindmapSystemPrompt,
    buildMindmapUserMessage,
    extractJsonObjectText,
    isMindmapCacheHit,
    normalizeMindmapModelOutput,
    parseJsonOrNull,
} from "@/server/kb/mindmap-logic"
import { isDescendantKnowledgeBaseNode, moveNodeIdIntoSiblingOrder } from "@/server/kb/node-move-logic"
import {
    assertKnowledgeBaseOwner,
    listUserKnowledgeBases,
    readWikiPageForAgent,
    searchWikiPagesAcrossKbs,
    searchWikiPagesForAgent,
} from "@/server/kb/wiki-agent-logic"
import { invalidatePublicArticleDetailCache, invalidatePublicArticleListCache } from "@/server/public-content-cache"
import { getServerConfig } from "@/config/server"
import { deleteS3Objects, extractS4ObjectKeysFromArticleContent } from "@/server/upload/s3-delete"
import {
    AGENT_API_KEY_SCOPES,
    agentApiKeyCreateSchema,
    agentApiKeyRevokeSchema,
    authenticateAgentRequest,
    generateAgentApiKey,
    hashAgentApiKey,
    parseAgentApiKeyExpiresAt,
    requireAgentScope,
    toAgentApiKeyPrefix,
    toAgentApiKeyResponse,
    type AgentAuthContext,
} from "@/server/agent/api-key"
import { buildAgentManifest, buildAgentSkillMarkdown, buildAgentSkillPackageZip } from "@/server/agent/skill"
import { getPublicBaseUrl } from "@/server/public-site/site-url"

type Db = ReturnType<typeof getDb>
type User = Awaited<ReturnType<typeof requireCurrentUser>>

const MAX_AGENT_LOG_TEXT_LENGTH = 100_000

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const optionalIdSchema = z.preprocess((value) => {
    if (value === undefined || value === null || String(value).trim() === "") return null
    return value
}, idSchema.nullable())

const agentArticleCreateSchema = z.object({
    contentJson: z.string().optional().nullable(),
    contentMd: z.string().min(1),
    contentMetaJson: z.string().optional().nullable(),
    knowledgeBaseId: idSchema,
    parentId: optionalIdSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional().default([]),
    title: z.string().trim().min(1).max(200),
})

const agentArticleUpdateSchema = z.object({
    articleId: idSchema,
    contentJson: z.string().optional().nullable(),
    contentMd: z.string().min(1),
    contentMetaJson: z.string().optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional().default([]),
    title: z.string().trim().min(1).max(200),
})

const agentArticleDeleteSchema = z.object({
    articleId: idSchema,
})

const agentFolderCreateSchema = z.object({
    knowledgeBaseId: idSchema,
    name: z.string().trim().min(1).max(200),
    parentId: optionalIdSchema.optional(),
})

const agentKnowledgeBaseTreeSchema = z.object({
    knowledgeBaseId: idSchema,
})

const agentCallLogListSchema = z.object({
    agentSource: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(30),
})

const agentDocumentSearchSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    limit: z.coerce.number().int().min(1).max(20).optional().default(8),
    query: z.string().trim().min(1).max(200),
})

const agentDocumentViewSchema = z.object({
    articleId: idSchema.optional(),
    knowledgeBaseId: idSchema.optional(),
    pageKey: z.string().trim().min(1).max(200).optional(),
}).refine((value) => Boolean(value.articleId || (value.knowledgeBaseId && value.pageKey)), {
    message: "必须提供 articleId，或同时提供 knowledgeBaseId 与 pageKey",
})

const agentDocumentQaSchema = z.object({
    configId: idSchema.optional().nullable(),
    knowledgeBaseId: idSchema.optional().nullable(),
    limit: z.coerce.number().int().min(1).max(10).optional().default(6),
    question: z.string().trim().min(1).max(1000),
})

const agentShareCreateSchema = z.object({
    articleId: idSchema,
    accessPassword: z.string().trim().regex(/^\d{6}$/, "访问密码必须是 6 位数字").optional().nullable(),
    passwordEnabled: z.boolean().optional(),
    expiresAt: z.string().trim().optional().nullable(),
})

const agentShareArticleIdSchema = z.object({
    articleId: idSchema,
})

const agentArticleSummaryGenerateSchema = z.object({
    articleId: idSchema,
    forceRebuild: z.boolean().optional().default(false),
})

const agentArticleMindmapGenerateSchema = z.object({
    articleId: idSchema,
    mode: z.enum(["MINDMAP", "KNOWLEDGE_GRAPH"]).optional().default("MINDMAP"),
    forceRebuild: z.boolean().optional().default(false),
})

const agentArticleListSchema = z.object({
    knowledgeBaseId: idSchema,
    parentId: optionalIdSchema.optional(),
    parentScope: z.enum(["DIRECT", "ANY"]).optional().default("ANY"),
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional().default([]),
    keyword: z.string().trim().max(200).optional().default(""),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

const agentArticleMoveSchema = z.object({
    articleId: idSchema,
    parentId: optionalIdSchema.optional(),
    targetIndex: z.coerce.number().int().min(0).optional(),
})

type AgentDocumentHit = {
    type: "wiki" | "article"
    knowledgeBaseId: string
    knowledgeBaseName?: string | null
    articleId?: string | null
    pageKey?: string | null
    title: string
    summary: string
    updatedAt: string | null
}

type AgentDocumentContext = AgentDocumentHit & {
    contentMd: string
}

type AgentTreeNode = {
    id: string
    parentId: string | null
    type: "FOLDER" | "ARTICLE"
    name: string
    articleId: string | null
    sortOrder: number
    children: AgentTreeNode[]
}

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

async function withAgent(request: NextRequest, handler: (context: AgentAuthContext) => Promise<Response>) {
    const startedAt = Date.now()
    const requestText = await readRequestTextForLog(request)
    let context: AgentAuthContext | null = null
    let attribution: AgentAttribution | null = null

    try {
        context = await authenticateAgentRequest(request)
        attribution = resolveAgentAttribution(request)
        const response = await handler(context)
        await recordAgentCallLog({
            attribution,
            context,
            durationMs: Date.now() - startedAt,
            request,
            requestText,
            response,
        })
        return response
    } catch (error) {
        const response = toErrorResponse(error, request.nextUrl.pathname)
        if (context) {
            await recordAgentCallLog({
                attribution: attribution ?? resolveMissingAgentAttribution(request),
                context,
                durationMs: Date.now() - startedAt,
                error,
                request,
                requestText,
                response,
            })
        }
        return response
    }
}

export async function listAgentApiKeys(request: NextRequest) {
    return withUser(request, async (user) => {
        const now = new Date()
        const rows = await getDb()
            .select()
            .from(agentApiKeys)
            .where(and(
                eq(agentApiKeys.userId, user.id),
                isNull(agentApiKeys.revokedAt),
                or(isNull(agentApiKeys.expiresAt), gt(agentApiKeys.expiresAt, now)),
            ))
            .orderBy(desc(agentApiKeys.createdAt), desc(agentApiKeys.id))

        return ok({ items: rows.map(toAgentApiKeyResponse) })
    })
}

export async function createAgentApiKey(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentApiKeyCreateSchema.parse(await readJson(request))
        const apiKey = generateAgentApiKey()
        const [record] = await getDb()
            .insert(agentApiKeys)
            .values({
                userId: user.id,
                name: input.name,
                keyHash: hashAgentApiKey(apiKey),
                keyPrefix: toAgentApiKeyPrefix(apiKey),
                scopesJson: JSON.stringify(input.scopes),
                expiresAt: parseAgentApiKeyExpiresAt(input.expiresAt),
            })
            .returning()

        return ok({
            apiKey,
            item: toAgentApiKeyResponse(record),
        })
    })
}

export async function revokeAgentApiKey(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentApiKeyRevokeSchema.parse(await readJson(request))
        const now = new Date()
        const [record] = await getDb()
            .update(agentApiKeys)
            .set({ revokedAt: now, updatedAt: now })
            .where(and(
                eq(agentApiKeys.id, input.id),
                eq(agentApiKeys.userId, user.id),
                isNull(agentApiKeys.revokedAt),
            ))
            .returning()

        if (!record) throw notFound("API Key 不存在")
        return ok({ item: toAgentApiKeyResponse(record) })
    })
}

export async function listAgentCallLogs(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentCallLogListSchema.parse(await readJson(request))
        const filters = [eq(agentCallLogs.userId, user.id)]
        if (input.agentSource) {
            filters.push(eq(agentCallLogs.agentSource, input.agentSource))
        }

        const rows = await getDb()
            .select()
            .from(agentCallLogs)
            .where(and(...filters))
            .orderBy(desc(agentCallLogs.createdAt), desc(agentCallLogs.id))
            .limit(input.limit)

        return ok({ items: rows.map(toAgentCallLogResponse) })
    })
}

export async function agentCapabilities(request: NextRequest) {
    return withAgent(request, async (context) => {
        const baseUrl = getRequestBaseUrl(request)
        return ok({
            name: "Petrichor Agent API",
            version: "2026-05-26",
            baseUrl,
            keyPrefix: context.apiKey.keyPrefix,
            scopes: context.scopes,
            supportedScopes: AGENT_API_KEY_SCOPES,
            capabilities: [
                "knowledge-base.list",
                "knowledge-base.tree",
                "folder.create",
                "article.create",
                "article.update",
                "article.delete",
                "article.list",
                "article.move",
                "article.share.create",
                "article.share.revoke",
                "article.share.info",
                "article.summary.generate",
                "article.mindmap.generate",
                "document.search",
                "document.view",
                "document.qa",
            ],
            manifest: buildAgentManifest(baseUrl),
            knowledgeBases: await listUserKnowledgeBases(context.userId),
        })
    })
}

type AgentAttribution = {
    source: string
    tool: string | null
}

function resolveAgentAttribution(request: NextRequest): AgentAttribution {
    const source = request.headers.get("x-petrichor-agent-source")?.trim() ?? ""
    const tool = request.headers.get("x-petrichor-agent-tool")?.trim() || null
    if (!source) {
        throw badRequest("缺少 X-Petrichor-Agent-Source 请求头")
    }
    if (source.length > 80) {
        throw badRequest("X-Petrichor-Agent-Source 不能超过 80 个字符")
    }
    if (tool && tool.length > 120) {
        throw badRequest("X-Petrichor-Agent-Tool 不能超过 120 个字符")
    }
    return { source, tool }
}

function resolveMissingAgentAttribution(request: NextRequest): AgentAttribution {
    return {
        source: "missing-source",
        tool: request.headers.get("x-petrichor-agent-tool")?.trim() || null,
    }
}

async function readRequestTextForLog(request: NextRequest) {
    try {
        return clipLogText(await request.clone().text())
    } catch {
        return null
    }
}

async function responseTextForLog(response: Response) {
    try {
        return clipLogText(await response.clone().text())
    } catch {
        return null
    }
}

async function recordAgentCallLog(input: {
    attribution: AgentAttribution
    context: AgentAuthContext
    durationMs: number
    error?: unknown
    request: NextRequest
    requestText: string | null
    response: Response
}) {
    try {
        await getDb()
            .insert(agentCallLogs)
            .values({
                userId: input.context.userId,
                apiKeyId: input.context.apiKey.id,
                apiKeyPrefix: input.context.apiKey.keyPrefix,
                agentSource: input.attribution.source,
                agentTool: input.attribution.tool,
                method: input.request.method,
                path: input.request.nextUrl.pathname,
                ip: resolveClientIp(input.request),
                userAgent: clipLogText(input.request.headers.get("user-agent"), 1000),
                requestJson: input.requestText,
                responseJson: await responseTextForLog(input.response),
                statusCode: input.response.status,
                durationMs: Math.max(0, Math.round(input.durationMs)),
                errorMessage: input.error ? describeAgentError(input.error) : null,
            })
    } catch (error) {
        console.warn("[Agent API] 调用日志写入失败", error)
    }
}

function resolveClientIp(request: NextRequest) {
    return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || request.headers.get("x-real-ip")?.trim()
        || request.headers.get("cf-connecting-ip")?.trim()
        || null
}

function describeAgentError(error: unknown) {
    return clipLogText(error instanceof Error ? error.message : String(error), 1000)
}

function clipLogText(value: string | null | undefined, maxLength = MAX_AGENT_LOG_TEXT_LENGTH) {
    if (!value) return null
    if (value.length <= maxLength) return value
    return `${value.slice(0, maxLength)}\n...[已截断，原始长度 ${value.length}]`
}

function toAgentCallLogResponse(record: typeof agentCallLogs.$inferSelect) {
    return {
        id: String(record.id),
        apiKeyId: String(record.apiKeyId),
        apiKeyPrefix: record.apiKeyPrefix,
        agentSource: record.agentSource,
        agentTool: record.agentTool,
        method: record.method,
        path: record.path,
        ip: record.ip,
        userAgent: record.userAgent,
        statusCode: record.statusCode,
        durationMs: record.durationMs,
        errorMessage: record.errorMessage,
        request: parseLogPayload(record.requestJson),
        response: parseLogPayload(record.responseJson),
        requestText: record.requestJson,
        responseText: record.responseJson,
        createdAt: formatDate(record.createdAt),
    }
}

function parseLogPayload(raw: string | null | undefined) {
    if (!raw?.trim()) return null
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return raw
    }
}

export async function agentManifest(request: NextRequest) {
    return ok(buildAgentManifest(getRequestBaseUrl(request)), {
        headers: {
            "Cache-Control": "public, max-age=300",
        },
    })
}

export async function agentListKnowledgeBases(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "doc:read")
        return ok({ items: await listUserKnowledgeBases(context.userId) })
    })
}

export async function agentKnowledgeBaseTree(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "doc:read")
        const input = agentKnowledgeBaseTreeSchema.parse(await readJson(request))
        const db = getDb()
        const knowledgeBase = await assertKnowledgeBaseOwner(db, context.userId, input.knowledgeBaseId)
        const nodes = await db
            .select()
            .from(knowledgeBaseNodes)
            .where(and(
                eq(knowledgeBaseNodes.userId, context.userId),
                eq(knowledgeBaseNodes.knowledgeBaseId, input.knowledgeBaseId),
            ))
            .orderBy(asc(knowledgeBaseNodes.sortOrder), asc(knowledgeBaseNodes.id))
        const articleNodeIds = nodes.filter((node) => node.type === "ARTICLE").map((node) => node.id)
        const articles = articleNodeIds.length > 0
            ? await db
                .select()
                .from(knowledgeBaseArticles)
                .where(and(
                    eq(knowledgeBaseArticles.userId, context.userId),
                    eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId),
                ))
            : []

        return ok({
            knowledgeBase: {
                id: String(knowledgeBase.id),
                name: knowledgeBase.name,
                description: knowledgeBase.description,
            },
            roots: buildAgentTree(nodes, new Map(articles.map((article) => [article.nodeId, article])), null),
        })
    })
}

export async function agentCreateFolder(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "article:write")
        const input = agentFolderCreateSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, context.userId, input.knowledgeBaseId)
        await assertFolderParent(db, context.userId, input.knowledgeBaseId, input.parentId)
        const sortOrder = await nextSortOrder(db, context.userId, input.knowledgeBaseId, input.parentId)
        const [node] = await db
            .insert(knowledgeBaseNodes)
            .values({
                userId: context.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                parentId: input.parentId ?? null,
                type: "FOLDER",
                name: input.name,
                sortOrder,
            })
            .returning()

        return ok({
            nodeId: String(node.id),
            knowledgeBaseId: String(node.knowledgeBaseId),
            parentId: node.parentId == null ? null : String(node.parentId),
            name: node.name,
            createdAt: formatDate(node.createdAt),
        })
    })
}

export async function agentCreateArticle(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "article:write")
        const input = agentArticleCreateSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, context.userId, input.knowledgeBaseId)
        await assertFolderParent(db, context.userId, input.knowledgeBaseId, input.parentId)
        const sortOrder = await nextSortOrder(db, context.userId, input.knowledgeBaseId, input.parentId)

        const [node] = await db
            .insert(knowledgeBaseNodes)
            .values({
                userId: context.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                parentId: input.parentId ?? null,
                type: "ARTICLE",
                name: input.title,
                sortOrder,
            })
            .returning()

        const [article] = await db
            .insert(knowledgeBaseArticles)
            .values({
                userId: context.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                nodeId: node.id,
                title: input.title,
                contentMd: input.contentMd,
                contentJson: input.contentJson || null,
                contentMetaJson: input.contentMetaJson || null,
                ...buildPublicArticleMetadata(input.contentMd),
            })
            .returning()

        await replaceArticleTags(db, article.id, input.tags)
        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()

        return ok({
            articleId: String(article.id),
            nodeId: String(node.id),
            knowledgeBaseId: String(article.knowledgeBaseId),
            title: article.title,
            createdAt: formatDate(article.createdAt),
        })
    })
}

export async function agentUpdateArticle(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "article:write")
        const input = agentArticleUpdateSchema.parse(await readJson(request))
        const db = getDb()
        const article = await loadOwnedArticle(db, context.userId, input.articleId)
        const previousImageObjectKeys = new Set(extractS4ObjectKeysFromArticleContent(article, context.userId))
        const nextImageObjectKeys = new Set(extractS4ObjectKeysFromArticleContent({
            contentJson: input.contentJson,
            contentMd: input.contentMd,
        }, context.userId))
        const removedImageObjectKeys = [...previousImageObjectKeys].filter((key) => !nextImageObjectKeys.has(key))

        await db
            .update(knowledgeBaseArticles)
            .set({
                title: input.title,
                contentMd: input.contentMd,
                contentJson: input.contentJson || null,
                contentMetaJson: input.contentMetaJson || null,
                ...buildPublicArticleMetadata(input.contentMd),
                updatedAt: new Date(),
            })
            .where(and(
                eq(knowledgeBaseArticles.id, input.articleId),
                eq(knowledgeBaseArticles.userId, context.userId),
            ))

        await db
            .update(knowledgeBaseNodes)
            .set({ name: input.title, updatedAt: new Date() })
            .where(and(
                eq(knowledgeBaseNodes.id, article.nodeId),
                eq(knowledgeBaseNodes.userId, context.userId),
            ))

        await replaceArticleTags(db, article.id, input.tags)
        scheduleUnreferencedS4Cleanup(context.userId, removedImageObjectKeys, { action: "agentUpdateArticle" })

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            nodeId: String(article.nodeId),
            knowledgeBaseId: String(article.knowledgeBaseId),
            title: input.title,
            updatedAt: new Date().toISOString(),
        })
    })
}

export async function agentDeleteArticle(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "article:delete")
        const input = agentArticleDeleteSchema.parse(await readJson(request))
        const db = getDb()
        const article = await loadOwnedArticle(db, context.userId, input.articleId)
        const imageObjectKeys = extractS4ObjectKeysFromArticleContent(article, context.userId)

        await db.delete(knowledgeBaseArticleTags).where(eq(knowledgeBaseArticleTags.articleId, article.id))
        await db.delete(knowledgeBaseArticles).where(and(
            eq(knowledgeBaseArticles.id, article.id),
            eq(knowledgeBaseArticles.userId, context.userId),
        ))
        await db.delete(knowledgeBaseNodes).where(and(
            eq(knowledgeBaseNodes.id, article.nodeId),
            eq(knowledgeBaseNodes.userId, context.userId),
        ))
        scheduleUnreferencedS4Cleanup(context.userId, imageObjectKeys, { action: "agentDeleteArticle" })

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            nodeId: String(article.nodeId),
            knowledgeBaseId: String(article.knowledgeBaseId),
            title: article.title,
            deletedAt: new Date().toISOString(),
        })
    })
}

export async function agentSearchDocuments(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "doc:read")
        const input = agentDocumentSearchSchema.parse(await readJson(request))
        const items = await searchAgentDocuments({
            userId: context.userId,
            knowledgeBaseId: input.knowledgeBaseId ?? null,
            query: input.query,
            limit: input.limit,
        })
        return ok({ items })
    })
}

export async function agentViewDocument(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "doc:read")
        const input = agentDocumentViewSchema.parse(await readJson(request))

        if (input.articleId) {
            const article = await loadOwnedArticle(getDb(), context.userId, input.articleId)
            const tags = await loadTags(getDb(), article.id)
            return ok({
                type: "article",
                articleId: String(article.id),
                knowledgeBaseId: String(article.knowledgeBaseId),
                nodeId: String(article.nodeId),
                title: article.title,
                contentMd: article.contentMd,
                tags,
                createdAt: formatDate(article.createdAt),
                updatedAt: formatDate(article.updatedAt),
            })
        }

        const page = await readWikiPageForAgent(context.userId, input.knowledgeBaseId!, input.pageKey!)
        return ok({
            type: "wiki",
            ...page,
        })
    })
}

export async function agentAskDocument(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "qa:read")
        const input = agentDocumentQaSchema.parse(await readJson(request))
        const contexts = await loadAgentDocumentContexts({
            userId: context.userId,
            knowledgeBaseId: input.knowledgeBaseId ?? null,
            question: input.question,
            limit: input.limit,
        })

        if (contexts.length === 0) {
            return ok({
                answer: "未找到足够的文档依据回答这个问题。",
                citations: [],
                usage: null,
                modelName: null,
            })
        }

        const completion = await callChatCompletion({
            userId: context.userId,
            configId: input.configId ?? null,
            systemPrompt: [
                "你是 Petrichor 的外部文档问答接口。",
                "只基于用户提供的文档上下文回答。",
                "如果上下文不足，明确说明无法从现有文档确认。",
                "用中文回答，保持简洁，并在答案末尾列出依据标题。",
            ].join("\n"),
            message: buildQaPrompt(input.question, contexts),
        })

        return ok({
            answer: completion.answer,
            citations: contexts.map(toCitation),
            modelName: completion.modelName,
            reasoning: completion.reasoning,
            usage: completion.usage,
        })
    })
}

export async function agentShareCreate(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "share:write")
        const input = agentShareCreateSchema.parse(await readJson(request))
        const db = getDb()
        await loadOwnedArticle(db, context.userId, input.articleId)

        const [existing] = await db
            .select()
            .from(knowledgeBaseArticleShares)
            .where(eq(knowledgeBaseArticleShares.articleId, input.articleId))
            .limit(1)

        const expiresAt = parseAgentShareExpiresAt(input.expiresAt ?? null)
        const passwordEnabled = input.passwordEnabled ?? null
        const accessPassword = (input.accessPassword ?? "").trim()
        const passwordHash = await resolveAgentSharePasswordHash(existing, passwordEnabled, accessPassword)
        const shareCode = existing && existing.enabled && existing.shareCode.trim()
            ? existing.shareCode
            : randomBytes(18).toString("base64url")

        const values = {
            userId: context.userId,
            articleId: input.articleId,
            shareCode,
            enabled: true,
            expiresAt,
            passwordHash,
            revokedAt: null,
            updatedAt: new Date(),
        }

        const [share] = existing
            ? await db
                .update(knowledgeBaseArticleShares)
                .set(values)
                .where(eq(knowledgeBaseArticleShares.id, existing.id))
                .returning()
            : await db
                .insert(knowledgeBaseArticleShares)
                .values(values)
                .returning()

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache(share.shareCode)
        if (existing?.shareCode && existing.shareCode !== share.shareCode) {
            invalidatePublicArticleDetailCache(existing.shareCode)
        }
        return ok(toAgentShareResponse(share))
    })
}

export async function agentShareRevoke(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "share:write")
        const input = agentShareArticleIdSchema.parse(await readJson(request))
        const db = getDb()
        await loadOwnedArticle(db, context.userId, input.articleId)

        const [share] = await db
            .select()
            .from(knowledgeBaseArticleShares)
            .where(eq(knowledgeBaseArticleShares.articleId, input.articleId))
            .limit(1)

        if (!share) {
            return ok({
                articleId: String(input.articleId),
                enabled: false,
                revokedAt: null,
            })
        }
        if (!share.enabled) {
            return ok({
                articleId: String(input.articleId),
                enabled: false,
                revokedAt: formatDate(share.revokedAt),
            })
        }

        const revokedAt = new Date()
        await db
            .update(knowledgeBaseArticleShares)
            .set({ enabled: false, revokedAt, updatedAt: revokedAt })
            .where(eq(knowledgeBaseArticleShares.id, share.id))

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache(share.shareCode)
        return ok({
            articleId: String(input.articleId),
            enabled: false,
            revokedAt: revokedAt.toISOString(),
        })
    })
}

export async function agentShareInfo(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "share:write")
        const input = agentShareArticleIdSchema.parse(await readJson(request))
        const db = getDb()
        await loadOwnedArticle(db, context.userId, input.articleId)

        const [share] = await db
            .select()
            .from(knowledgeBaseArticleShares)
            .where(eq(knowledgeBaseArticleShares.articleId, input.articleId))
            .limit(1)

        if (!share) {
            return ok({
                articleId: String(input.articleId),
                shareCode: null,
                shareUrl: null,
                enabled: false,
                hasPassword: false,
                expiresAt: null,
                updatedAt: null,
            })
        }

        return ok({
            ...toAgentShareResponse(share),
            shareCode: share.enabled && share.shareCode.trim() ? share.shareCode : null,
        })
    })
}

export async function agentGenerateArticleSummary(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "ai:write")
        const input = agentArticleSummaryGenerateSchema.parse(await readJson(request))
        const db = getDb()
        const article = await loadOwnedArticle(db, context.userId, input.articleId)

        const currentHash = buildArticleAiSummaryContentHash(article.contentMd)
        if (!input.forceRebuild && isArticleAiSummaryCacheHit({
            currentHash,
            storedHash: article.aiSummaryContentHash,
            summary: article.aiSummary,
        })) {
            return ok({
                articleId: String(article.id),
                fromCache: true,
                summary: article.aiSummary?.trim() ?? "",
                generatedAt: formatDate(article.aiSummaryGeneratedAt ?? article.updatedAt),
            })
        }

        const result = await callChatCompletion({
            userId: context.userId,
            systemPrompt: buildArticleSummarySystemPrompt(),
            message: buildArticleSummaryUserMessage({
                title: article.title,
                contentMd: article.contentMd,
            }),
        })
        const summary = normalizeArticleSummaryModelOutput(result.answer)
        const generatedAt = new Date()

        await db
            .update(knowledgeBaseArticles)
            .set({
                aiSummary: summary,
                aiSummaryContentHash: currentHash,
                aiSummaryGeneratedAt: generatedAt,
                updatedAt: generatedAt,
            })
            .where(and(
                eq(knowledgeBaseArticles.id, article.id),
                eq(knowledgeBaseArticles.userId, context.userId),
            ))

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            fromCache: false,
            summary,
            generatedAt: generatedAt.toISOString(),
        })
    })
}

export async function agentGenerateArticleMindmap(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "ai:write")
        const input = agentArticleMindmapGenerateSchema.parse(await readJson(request))
        const db = getDb()
        const article = await loadOwnedArticle(db, context.userId, input.articleId)

        const [kb] = await db
            .select()
            .from(knowledgeBases)
            .where(eq(knowledgeBases.id, article.knowledgeBaseId))
            .limit(1)
        if (!kb) throw notFound("知识库不存在")

        const currentHash = buildMindmapContentHash(article.title, article.contentMd)
        const storedHash = input.mode === "KNOWLEDGE_GRAPH" ? article.mindmapKgContentHash : article.mindmapContentHash
        const storedJson = input.mode === "KNOWLEDGE_GRAPH" ? article.mindmapKgJson : article.mindmapJson
        const storedGeneratedAt = input.mode === "KNOWLEDGE_GRAPH" ? article.mindmapKgGeneratedAt : article.mindmapGeneratedAt

        if (!input.forceRebuild && isMindmapCacheHit({ currentHash, storedHash, storedJson })) {
            const cached = parseJsonOrNull(storedJson)
            if (cached) {
                return ok({
                    articleId: String(article.id),
                    mode: input.mode,
                    fromCache: true,
                    generatedAt: formatDate(storedGeneratedAt ?? article.updatedAt),
                    data: cached,
                })
            }
        }

        const completion = await callChatCompletion({
            userId: context.userId,
            systemPrompt: buildMindmapSystemPrompt(input.mode),
            message: buildMindmapUserMessage({
                knowledgeBaseName: kb.name,
                title: article.title,
                contentMd: article.contentMd,
            }),
        })
        let generated: unknown
        try {
            const raw = JSON.parse(extractJsonObjectText(completion.answer))
            generated = normalizeMindmapModelOutput(raw, article.title, input.mode)
        } catch (error) {
            if (error instanceof Error && error.message.includes("未找到可用的默认配置")) {
                throw error
            }
            throw badRequest(`生成${input.mode === "KNOWLEDGE_GRAPH" ? "知识图谱" : "思维导图"}失败，请稍后重试`)
        }

        const generatedAt = new Date()
        if (input.mode === "KNOWLEDGE_GRAPH") {
            await db
                .update(knowledgeBaseArticles)
                .set({
                    mindmapKgJson: JSON.stringify(generated),
                    mindmapKgContentHash: currentHash,
                    mindmapKgGeneratedAt: generatedAt,
                    updatedAt: generatedAt,
                })
                .where(eq(knowledgeBaseArticles.id, article.id))
        } else {
            await db
                .update(knowledgeBaseArticles)
                .set({
                    mindmapJson: JSON.stringify(generated),
                    mindmapContentHash: currentHash,
                    mindmapGeneratedAt: generatedAt,
                    updatedAt: generatedAt,
                })
                .where(eq(knowledgeBaseArticles.id, article.id))
        }

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            mode: input.mode,
            fromCache: false,
            generatedAt: generatedAt.toISOString(),
            data: generated,
        })
    })
}

export async function agentListArticles(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "doc:read")
        const input = agentArticleListSchema.parse(await readJson(request))
        const db = getDb()
        await assertKnowledgeBaseOwner(db, context.userId, input.knowledgeBaseId)

        const filters: SQL[] = [
            eq(knowledgeBaseArticles.userId, context.userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId),
        ]
        if (input.keyword) {
            filters.push(ilike(knowledgeBaseArticles.title, `%${input.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`))
        }

        const articleRows = await db
            .select({
                article: knowledgeBaseArticles,
                node: knowledgeBaseNodes,
            })
            .from(knowledgeBaseArticles)
            .innerJoin(knowledgeBaseNodes, eq(knowledgeBaseNodes.id, knowledgeBaseArticles.nodeId))
            .where(and(...filters))
            .orderBy(desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticles.id))

        const parentId = input.parentId ?? null
        const hasParentFilter = Object.prototype.hasOwnProperty.call(input, "parentId")
        const articleIds = articleRows.map((row) => row.article.id)
        const [tagsByArticle, nodeMap] = await Promise.all([
            loadTagsByArticleIds(db, articleIds),
            loadKnowledgeBaseNodeMap(db, context.userId, input.knowledgeBaseId),
        ])

        const requiredTags = new Set(input.tags ?? [])
        const filteredByTag = articleRows.filter((row) => {
            if (requiredTags.size === 0) return true
            const tags = new Set(tagsByArticle.get(row.article.id) ?? [])
            for (const tag of requiredTags) if (!tags.has(tag)) return false
            return true
        })

        const filteredByParent = filteredByTag.filter((row) => {
            if (!hasParentFilter) return true
            if (input.parentScope === "DIRECT") {
                return (row.node.parentId ?? null) === parentId
            }
            return parentId == null
                ? true
                : isNodeUnderAncestor(nodeMap, row.node.id, parentId)
        })

        const totalAfterFilter = filteredByParent.length
        const limited = filteredByParent.slice(0, input.limit)
        const items = limited.map((row) => ({
            articleId: String(row.article.id),
            nodeId: String(row.node.id),
            knowledgeBaseId: String(row.article.knowledgeBaseId),
            parentId: row.node.parentId == null ? null : String(row.node.parentId),
            title: row.article.title,
            tags: tagsByArticle.get(row.article.id) ?? [],
            path: buildArticlePath(nodeMap, row.node.id),
            sortOrder: row.node.sortOrder,
            createdAt: formatDate(row.article.createdAt),
            updatedAt: formatDate(row.article.updatedAt),
        }))

        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            items,
            hasMore: totalAfterFilter > items.length,
        })
    })
}

export async function agentMoveArticle(request: NextRequest) {
    return withAgent(request, async (context) => {
        requireAgentScope(context, "article:write")
        const input = agentArticleMoveSchema.parse(await readJson(request))
        const db = getDb()
        const article = await loadOwnedArticle(db, context.userId, input.articleId)
        const targetParentId = input.parentId ?? null

        await assertFolderParent(db, context.userId, article.knowledgeBaseId, targetParentId)

        const allNodes = await db
            .select()
            .from(knowledgeBaseNodes)
            .where(and(
                eq(knowledgeBaseNodes.userId, context.userId),
                eq(knowledgeBaseNodes.knowledgeBaseId, article.knowledgeBaseId),
            ))

        const nodeId = article.nodeId
        if (targetParentId === nodeId || isDescendantKnowledgeBaseNode(allNodes, nodeId, targetParentId)) {
            throw badRequest("不能把节点移动到自身或子文件夹中")
        }

        const node = allNodes.find((item) => item.id === nodeId)
        if (!node) throw notFound("文章节点不存在")

        const sourceParentId = node.parentId ?? null
        const sourceSiblings = allNodes
            .filter((item) => (item.parentId ?? null) === sourceParentId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        const targetSiblings = allNodes
            .filter((item) => (item.parentId ?? null) === targetParentId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)

        const targetOrder = moveNodeIdIntoSiblingOrder(
            targetSiblings.map((item) => item.id),
            nodeId,
            input.targetIndex,
        )
        const sourceOrder = sourceParentId === targetParentId
            ? targetOrder
            : sourceSiblings.map((item) => item.id).filter((id) => id !== nodeId)

        const updatedAt = new Date()
        if (sourceParentId !== targetParentId) {
            for (const [index, id] of sourceOrder.entries()) {
                await db
                    .update(knowledgeBaseNodes)
                    .set({ sortOrder: index + 1, updatedAt })
                    .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, context.userId)))
            }
        }
        for (const [index, id] of targetOrder.entries()) {
            const values = id === nodeId
                ? { parentId: targetParentId, sortOrder: index + 1, updatedAt }
                : { sortOrder: index + 1, updatedAt }
            await db
                .update(knowledgeBaseNodes)
                .set(values)
                .where(and(eq(knowledgeBaseNodes.id, id), eq(knowledgeBaseNodes.userId, context.userId)))
        }

        if (sourceParentId !== targetParentId) {
            invalidatePublicArticleListCache()
            invalidatePublicArticleDetailCache()
        }

        return ok({
            articleId: String(article.id),
            nodeId: String(nodeId),
            knowledgeBaseId: String(article.knowledgeBaseId),
            parentId: targetParentId == null ? null : String(targetParentId),
            updatedAt: updatedAt.toISOString(),
        })
    })
}

async function loadTagsByArticleIds(db: Db, articleIds: number[]) {
    if (articleIds.length === 0) return new Map<number, string[]>()
    const rows = await db
        .select({ articleId: knowledgeBaseArticleTags.articleId, tag: knowledgeBaseArticleTags.tag })
        .from(knowledgeBaseArticleTags)
        .where(inArray(knowledgeBaseArticleTags.articleId, articleIds))
        .orderBy(asc(knowledgeBaseArticleTags.tag))
    const result = new Map<number, string[]>()
    for (const row of rows) {
        const list = result.get(row.articleId) ?? []
        list.push(row.tag)
        result.set(row.articleId, list)
    }
    return result
}

async function loadKnowledgeBaseNodeMap(db: Db, userId: number, knowledgeBaseId: number) {
    const rows = await db
        .select({
            id: knowledgeBaseNodes.id,
            parentId: knowledgeBaseNodes.parentId,
            name: knowledgeBaseNodes.name,
        })
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId),
        ))
    return new Map(rows.map((node) => [node.id, node]))
}

function isNodeUnderAncestor(
    nodeMap: Map<number, { id: number; parentId: number | null }>,
    nodeId: number,
    ancestorId: number,
) {
    let current = nodeMap.get(nodeId)
    let depth = 0
    while (current && depth < 100) {
        if (current.parentId === ancestorId) return true
        if (current.parentId == null) return false
        current = nodeMap.get(current.parentId)
        depth += 1
    }
    return false
}

function parseAgentShareExpiresAt(value: string | null) {
    const text = (value ?? "").trim()
    if (!text) return null
    const date = new Date(text)
    if (Number.isNaN(date.getTime())) {
        throw badRequest("expiresAt 必须是合法 ISO 8601 时间，例如 2026-12-31T23:59:59Z")
    }
    if (date.getTime() <= Date.now()) {
        throw badRequest("expiresAt 必须晚于当前时间")
    }
    return date
}

async function resolveAgentSharePasswordHash(
    existing: KnowledgeBaseArticleShareRecord | undefined,
    passwordEnabled: boolean | null,
    accessPassword: string,
) {
    if (passwordEnabled === false) {
        return null
    }
    if (passwordEnabled === true && !accessPassword && !existing?.passwordHash?.trim()) {
        throw badRequest("启用密码时必须提供 accessPassword（6 位数字）")
    }
    if (!accessPassword) {
        return passwordEnabled === true ? existing?.passwordHash ?? null : null
    }
    return await bcrypt.hash(accessPassword, 10)
}

function toAgentShareResponse(share: KnowledgeBaseArticleShareRecord) {
    return {
        articleId: String(share.articleId),
        shareCode: share.shareCode,
        shareUrl: `/p/${share.shareCode}`,
        enabled: share.enabled,
        hasPassword: Boolean(share.passwordHash?.trim()),
        expiresAt: formatDate(share.expiresAt),
        updatedAt: formatDate(share.updatedAt),
        ...buildPublicShareRepostAttribution(share),
    }
}

export async function agentSkill(request: NextRequest) {
    const baseUrl = getRequestBaseUrl(request)
    return new NextResponse(buildAgentSkillMarkdown(baseUrl), {
        headers: {
            "Cache-Control": "public, max-age=300",
            "Content-Disposition": "attachment; filename=\"SKILL.md\"",
            "Content-Type": "text/markdown; charset=utf-8",
        },
    })
}

export async function agentSkillPack(request: NextRequest) {
    const baseUrl = getRequestBaseUrl(request)
    return new NextResponse(buildAgentSkillPackageZip(baseUrl), {
        headers: {
            "Cache-Control": "public, max-age=300",
            "Content-Disposition": "attachment; filename=\"petrichor-agent-skills.zip\"",
            "Content-Type": "application/zip",
        },
    })
}

function getRequestBaseUrl(request: NextRequest) {
    const requestOrigin = request.nextUrl.origin
    return requestOrigin && requestOrigin !== "null" ? requestOrigin : getPublicBaseUrl()
}

async function assertFolderParent(db: Db, userId: number, knowledgeBaseId: number, parentId: number | null | undefined) {
    if (parentId == null) return
    const [parent] = await db
        .select()
        .from(knowledgeBaseNodes)
        .where(and(eq(knowledgeBaseNodes.id, parentId), eq(knowledgeBaseNodes.userId, userId)))
        .limit(1)
    if (!parent || parent.knowledgeBaseId !== knowledgeBaseId || parent.type !== "FOLDER") {
        throw badRequest("父节点必须是当前知识库下的文件夹")
    }
}

async function nextSortOrder(db: Db, userId: number, knowledgeBaseId: number, parentId: number | null | undefined) {
    const [last] = await db
        .select({ sortOrder: knowledgeBaseNodes.sortOrder })
        .from(knowledgeBaseNodes)
        .where(and(
            eq(knowledgeBaseNodes.userId, userId),
            eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId),
            parentId == null ? isNull(knowledgeBaseNodes.parentId) : eq(knowledgeBaseNodes.parentId, parentId),
        ))
        .orderBy(desc(knowledgeBaseNodes.sortOrder))
        .limit(1)

    return (last?.sortOrder ?? 0) + 1
}

function buildAgentTree(
    nodes: Array<typeof knowledgeBaseNodes.$inferSelect>,
    articleByNodeId: Map<number, KnowledgeBaseArticleRecord>,
    parentId: number | null,
): AgentTreeNode[] {
    return nodes
        .filter((node) => (node.parentId ?? null) === parentId)
        .map((node) => {
            const article = articleByNodeId.get(node.id)
            return {
                id: String(node.id),
                parentId: node.parentId == null ? null : String(node.parentId),
                type: node.type as "FOLDER" | "ARTICLE",
                name: node.name,
                articleId: article ? String(article.id) : null,
                sortOrder: node.sortOrder,
                children: buildAgentTree(nodes, articleByNodeId, node.id),
            }
        })
}

async function replaceArticleTags(db: Db, articleId: number, tags: string[]) {
    await db.delete(knowledgeBaseArticleTags).where(eq(knowledgeBaseArticleTags.articleId, articleId))
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50)
    if (normalized.length > 0) {
        await db.insert(knowledgeBaseArticleTags).values(normalized.map((tag) => ({ articleId, tag })))
    }
}

async function loadTags(db: Db, articleId: number) {
    const rows = await db
        .select({ tag: knowledgeBaseArticleTags.tag })
        .from(knowledgeBaseArticleTags)
        .where(eq(knowledgeBaseArticleTags.articleId, articleId))
        .orderBy(asc(knowledgeBaseArticleTags.tag))
    return rows.map((row) => row.tag)
}

async function loadOwnedArticle(db: Db, userId: number, articleId: number) {
    const [article] = await db
        .select()
        .from(knowledgeBaseArticles)
        .where(and(eq(knowledgeBaseArticles.id, articleId), eq(knowledgeBaseArticles.userId, userId)))
        .limit(1)
    if (!article) throw notFound("文章不存在")
    return article
}

async function searchAgentDocuments(input: {
    userId: number
    knowledgeBaseId: number | null
    query: string
    limit: number
}): Promise<AgentDocumentHit[]> {
    const [wikiHits, articleHits] = await Promise.all([
        searchAgentWikiDocuments(input),
        searchSourceArticles(input),
    ])

    const seen = new Set<string>()
    const items: AgentDocumentHit[] = []
    for (const hit of [...wikiHits, ...articleHits]) {
        const key = `${hit.type}:${hit.knowledgeBaseId}:${hit.pageKey ?? hit.articleId ?? hit.title}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push(hit)
        if (items.length >= input.limit) break
    }
    return items
}

async function searchAgentWikiDocuments(input: {
    userId: number
    knowledgeBaseId: number | null
    query: string
    limit: number
}): Promise<AgentDocumentHit[]> {
    if (input.knowledgeBaseId != null) {
        await assertKnowledgeBaseOwner(getDb(), input.userId, input.knowledgeBaseId)
        const rows = await searchWikiPagesForAgent({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            query: input.query,
            limit: input.limit,
        })
        return rows.map((row) => ({
            type: "wiki",
            knowledgeBaseId: String(input.knowledgeBaseId),
            articleId: row.articleId,
            pageKey: row.pageKey,
            title: row.title,
            summary: row.summary,
            updatedAt: row.updatedAt,
        }))
    }

    const rows = await searchWikiPagesAcrossKbs({
        userId: input.userId,
        query: input.query,
        limit: input.limit,
    })
    return rows.map((row) => ({
        type: "wiki",
        knowledgeBaseId: row.knowledgeBaseId,
        knowledgeBaseName: row.knowledgeBaseName,
        articleId: row.articleId,
        pageKey: row.pageKey,
        title: row.title,
        summary: row.summary,
        updatedAt: row.updatedAt,
    }))
}

async function searchSourceArticles(input: {
    userId: number
    knowledgeBaseId: number | null
    query: string
    limit: number
}): Promise<AgentDocumentHit[]> {
    const db = getDb()
    const filters: SQL[] = [eq(knowledgeBaseArticles.userId, input.userId)]
    if (input.knowledgeBaseId != null) {
        filters.push(eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId))
    }
    const keyword = `%${escapeLike(input.query)}%`
    filters.push(or(
        ilike(knowledgeBaseArticles.title, keyword),
        ilike(knowledgeBaseArticles.contentMd, keyword),
    )!)

    const rows = await db
        .select({
            article: knowledgeBaseArticles,
            kbName: knowledgeBases.name,
        })
        .from(knowledgeBaseArticles)
        .innerJoin(knowledgeBases, eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBases.id))
        .where(and(...filters))
        .orderBy(desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticles.id))
        .limit(input.limit)

    return rows.map(({ article, kbName }) => ({
        type: "article",
        knowledgeBaseId: String(article.knowledgeBaseId),
        knowledgeBaseName: kbName,
        articleId: String(article.id),
        pageKey: null,
        title: article.title,
        summary: summarizeMarkdown(article.contentMd, 220),
        updatedAt: formatDate(article.updatedAt),
    }))
}

async function loadAgentDocumentContexts(input: {
    userId: number
    knowledgeBaseId: number | null
    question: string
    limit: number
}) {
    const hits = await searchAgentDocuments({
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        query: input.question,
        limit: input.limit,
    })

    const contexts: AgentDocumentContext[] = []
    for (const hit of hits) {
        if (hit.type === "wiki" && hit.pageKey) {
            const page = await readWikiPageForAgent(input.userId, Number(hit.knowledgeBaseId), hit.pageKey)
            contexts.push({
                ...hit,
                contentMd: page.contentMd,
            })
            continue
        }
        if (hit.articleId) {
            const article = await loadOwnedArticle(getDb(), input.userId, Number(hit.articleId))
            contexts.push({
                ...hit,
                contentMd: article.contentMd,
            })
        }
    }
    return contexts
}

function buildQaPrompt(question: string, contexts: AgentDocumentContext[]) {
    const contextText = contexts
        .map((item, index) => [
            `## 文档 ${index + 1}: ${item.title}`,
            `类型：${item.type === "wiki" ? "Wiki 页面" : "源文章"}`,
            `知识库 ID：${item.knowledgeBaseId}`,
            item.articleId ? `文章 ID：${item.articleId}` : null,
            item.pageKey ? `页面 Key：${item.pageKey}` : null,
            "",
            truncateText(item.contentMd, 6000),
        ].filter(Boolean).join("\n"))
        .join("\n\n---\n\n")

    return [
        `问题：${question}`,
        "",
        "文档上下文：",
        contextText,
    ].join("\n")
}

function toCitation(item: AgentDocumentContext) {
    return {
        type: item.type,
        knowledgeBaseId: item.knowledgeBaseId,
        knowledgeBaseName: item.knowledgeBaseName ?? null,
        articleId: item.articleId ?? null,
        pageKey: item.pageKey ?? null,
        title: item.title,
        summary: item.summary,
        updatedAt: item.updatedAt,
    }
}

function escapeLike(value: string) {
    return value.replace(/[%_\\]/g, (char) => `\\${char}`)
}

function summarizeMarkdown(markdown: string, maxLength: number) {
    return truncateText(markdown.replace(/[`*_>#\-[\]()!]/g, " ").replace(/\s+/g, " ").trim(), maxLength)
}

function truncateText(value: string, maxLength: number) {
    const text = value.trim()
    if (text.length <= maxLength) return text
    return `${text.slice(0, maxLength - 1)}…`
}

function formatDate(value: Date | string | null | undefined): string | null {
    if (!value) return null
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function scheduleUnreferencedS4Cleanup(
    userId: number,
    candidateKeys: string[],
    context: { action: string },
) {
    const uniqueCandidateKeys = [...new Set(candidateKeys)]
    if (uniqueCandidateKeys.length === 0) return
    const task = () => cleanupUnreferencedS4Objects(userId, uniqueCandidateKeys, context)

    try {
        after(task)
    } catch {
        setTimeout(() => {
            void task()
        }, 0)
    }
}

async function cleanupUnreferencedS4Objects(
    userId: number,
    candidateKeys: string[],
    context: { action: string },
) {
    try {
        const db = getDb()
        const referencedKeys = await loadReferencedS4ObjectKeys(db, userId, candidateKeys)
        const deletableKeys = candidateKeys.filter((key) => !referencedKeys.has(key))
        if (deletableKeys.length === 0) return

        const config = getServerConfig().s3
        if (!config) return

        const summary = await deleteS3Objects(config, deletableKeys)
        if (summary.failedObjectKeys.length > 0) {
            console.warn("[Agent API] 部分文章图片对象清理失败", {
                action: context.action,
                failedObjectKeys: summary.failedObjectKeys,
                userId,
            })
        }
    } catch (error) {
        console.warn("[Agent API] 文章图片清理流程失败，已保留删除结果", {
            action: context.action,
            error: error instanceof Error ? error.message : String(error),
            userId,
        })
    }
}

async function loadReferencedS4ObjectKeys(db: Db, userId: number, candidateKeys: string[]) {
    const candidateSet = new Set(candidateKeys)
    const referenced = new Set<string>()
    if (candidateSet.size === 0) return referenced

    const rows: Array<Pick<KnowledgeBaseArticleRecord, "contentJson" | "contentMd">> = await db
        .select({
            contentJson: knowledgeBaseArticles.contentJson,
            contentMd: knowledgeBaseArticles.contentMd,
        })
        .from(knowledgeBaseArticles)
        .where(eq(knowledgeBaseArticles.userId, userId))

    for (const row of rows) {
        for (const key of extractS4ObjectKeysFromArticleContent(row, userId)) {
            if (candidateSet.has(key)) referenced.add(key)
        }
    }
    return referenced
}
