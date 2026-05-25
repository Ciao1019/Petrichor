import { randomBytes } from "node:crypto"
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseArticleShares,
    knowledgeBaseArticleTags,
    knowledgeBaseNodes,
    knowledgeBases,
    type KnowledgeBaseArticleShareRecord,
} from "@/server/db/schema"
import { badRequest, forbidden, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    cachePublicArticleDetail,
    cachePublicContent,
    invalidatePublicArticleDetailCache,
    invalidatePublicArticleListCache,
} from "@/server/public-content-cache"
import {
    buildArticlePath,
    buildPublicArticleMetadata,
    buildPublicArticleContentHash,
    buildPublicShareRepostAttribution,
    parseShareExpiresAt,
    resolvePublicHomepageShareStatus,
    resolvePublicArticleToc,
    validateArticleSearchInput,
    validatePublicArticleSearchInput,
    validatePublicShareDetailInput,
    validatePublicShareRepostAttributionInput,
    validateShareArticleIdInput,
    validateSharePassword,
} from "./share-logic"
import { buildArticleAiSummaryExcerpt, resolveDisplayArticleAiSummary, resolveUsableArticleAiSummary } from "./article-summary-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

const loadCachedPublicArticleList = cachePublicContent("articleList", loadPublicArticleListResponse)
const publicArticleListCacheControl = "public, max-age=60, s-maxage=60, stale-while-revalidate=300"
const publicArticleDetailCacheControl = "public, max-age=300, s-maxage=300, stale-while-revalidate=600"
const privatePublicArticleDetailCacheControl = "no-store"

type PublicShareDetailLoadInput = {
    shareCode: string
    accessPassword?: string | null
    allowPassword: boolean
}

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

async function withPublic(request: NextRequest, handler: () => Promise<Response>) {
    try {
        return await handler()
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function searchArticles(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateArticleSearchInput(await readJson(request))
        const db = getDb()
        const [kb] = await db
            .select({ id: knowledgeBases.id })
            .from(knowledgeBases)
            .where(and(eq(knowledgeBases.id, input.knowledgeBaseId), eq(knowledgeBases.userId, user.id)))
            .limit(1)
        if (!kb) {
            throw notFound("知识库不存在")
        }

        const filters = [
            eq(knowledgeBaseArticles.userId, user.id),
            eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId),
        ]
        if (input.keyword) {
            filters.push(ilike(knowledgeBaseArticles.title, `%${input.keyword}%`))
        }

        const articles = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(...filters))
            .orderBy(desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticles.id))

        const articleIds = articles.map((article) => article.id)
        const [tagsByArticle, nodeMap] = await Promise.all([
            loadTagsByArticleIds(articleIds),
            loadNodeMap(input.knowledgeBaseId),
        ])
        const requiredTags = new Set(input.tags)
        const items = articles
            .filter((article) => {
                if (requiredTags.size === 0) {
                    return true
                }
                const tags = new Set(tagsByArticle.get(article.id) ?? [])
                return [...requiredTags].every((tag) => tags.has(tag))
            })
            .map((article) => ({
                articleId: String(article.id),
                nodeId: String(article.nodeId),
                title: article.title,
                tags: tagsByArticle.get(article.id) ?? [],
                path: buildArticlePath(nodeMap, article.nodeId),
                updatedAt: formatDate(article.updatedAt),
            }))

        return ok({ items })
    })
}

export async function createArticleShare(request: NextRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const { articleId } = validateShareArticleIdInput(raw)
        const expiresAt = parseShareExpiresAt(raw.expiresAt)
        const repostAttribution = validatePublicShareRepostAttributionInput(raw)
        validateSharePassword(String(raw.accessPassword ?? ""))
        await requireOwner(user.id, articleId)

        const db = getDb()
        const [existing] = await db
            .select()
            .from(knowledgeBaseArticleShares)
            .where(eq(knowledgeBaseArticleShares.articleId, articleId))
            .limit(1)

        const accessPassword = String(raw.accessPassword ?? "").trim()
        const passwordEnabled = raw.passwordEnabled == null ? null : Boolean(raw.passwordEnabled)
        const passwordHash = await resolvePublicPasswordHash(existing, passwordEnabled, accessPassword)
        const shareCode = existing && existing.enabled && existing.shareCode.trim()
            ? existing.shareCode
            : generateShareCode()

        const values = {
            userId: user.id,
            articleId,
            shareCode,
            enabled: true,
            expiresAt,
            passwordHash,
            ...repostAttribution,
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
        return ok(buildShareCreateResponse(articleId, share))
    })
}

export async function revokeArticleShare(request: NextRequest) {
    return withUser(request, async (user) => {
        const { articleId } = validateShareArticleIdInput(await readJson(request))
        await requireOwner(user.id, articleId)
        const db = getDb()
        const [share] = await db
            .select()
            .from(knowledgeBaseArticleShares)
            .where(eq(knowledgeBaseArticleShares.articleId, articleId))
            .limit(1)

        if (!share) {
            return ok({ articleId: String(articleId), enabled: false, revokedAt: null })
        }
        if (!share.enabled) {
            return ok({
                articleId: String(articleId),
                enabled: false,
                revokedAt: formatDateOrNull(share.revokedAt),
            })
        }

        const revokedAt = new Date()
        await db
            .update(knowledgeBaseArticleShares)
            .set({ enabled: false, revokedAt, updatedAt: revokedAt })
            .where(eq(knowledgeBaseArticleShares.id, share.id))

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache(share.shareCode)
        return ok({ articleId: String(articleId), enabled: false, revokedAt: revokedAt.toISOString() })
    })
}

export async function articleShareInfo(request: NextRequest) {
    return withUser(request, async (user) => {
        const { articleId } = validateShareArticleIdInput(await readJson(request))
        await requireOwner(user.id, articleId)
        const [share] = await getDb()
            .select()
            .from(knowledgeBaseArticleShares)
            .where(eq(knowledgeBaseArticleShares.articleId, articleId))
            .limit(1)

        if (!share) {
            return ok({
                articleId: String(articleId),
                shareCode: null,
                enabled: false,
                hasPassword: false,
                expiresAt: null,
                ...buildPublicShareRepostAttribution(null),
                updatedAt: null,
            })
        }

        return ok({
            articleId: String(articleId),
            shareCode: share.enabled && share.shareCode.trim() ? share.shareCode : null,
            enabled: share.enabled,
            hasPassword: Boolean(share.passwordHash?.trim()),
            expiresAt: formatDateOrNull(share.expiresAt),
            ...buildPublicShareRepostAttribution(share),
            updatedAt: formatDateOrNull(share.updatedAt),
        })
    })
}

export async function publicShareDetail(request: NextRequest) {
    return withPublic(request, async () => {
        const input = validatePublicShareDetailInput(await readJson(request))
        return ok(await loadPublicShareDetailResponse({
            shareCode: input.shareCode,
            accessPassword: input.accessPassword,
            allowPassword: true,
        }), {
            headers: {
                "Cache-Control": privatePublicArticleDetailCacheControl,
            },
        })
    })
}

export async function publicShareDetailGet(request: NextRequest) {
    return withPublic(request, async () => {
        const input = validatePublicShareDetailInput({
            shareCode: request.nextUrl.searchParams.get("shareCode") ?? "",
            accessPassword: "",
        })
        const cachedLoader = cachePublicArticleDetail(input.shareCode, () => loadPublicShareDetailResponse({
            shareCode: input.shareCode,
            accessPassword: null,
            allowPassword: false,
        }))

        return ok(await cachedLoader(), {
            headers: {
                "Cache-Control": publicArticleDetailCacheControl,
            },
        })
    })
}

export async function publicArticleList(request: NextRequest) {
    return withPublic(request, async () => {
        return ok(await loadCachedPublicArticleList(), {
            headers: {
                "Cache-Control": publicArticleListCacheControl,
            },
        })
    })
}

const publicArticleSearchCacheControl = "public, max-age=15, s-maxage=15, stale-while-revalidate=60"

export async function publicArticleSearch(request: NextRequest) {
    return withPublic(request, async () => {
        const params = request.nextUrl.searchParams
        const input = validatePublicArticleSearchInput({
            keyword: params.get("q") ?? params.get("keyword"),
            limit: params.get("limit"),
            offset: params.get("offset"),
        })
        return ok(await loadPublicArticleSearchResponse(input), {
            headers: {
                "Cache-Control": publicArticleSearchCacheControl,
            },
        })
    })
}

async function loadPublicArticleSearchResponse(input: { keyword: string; limit: number; offset: number }) {
    const now = new Date()
    const keyword = input.keyword
    const likePattern = `%${escapeLikePattern(keyword)}%`
    const db = getDb()

    const rows = await db
        .select({
            articleId: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            updatedAt: knowledgeBaseArticles.updatedAt,
            publicExcerpt: knowledgeBaseArticles.publicExcerpt,
            publicContentHash: knowledgeBaseArticles.publicContentHash,
            aiSummary: knowledgeBaseArticles.aiSummary,
            readingMinutes: knowledgeBaseArticles.readingMinutes,
            shareCode: knowledgeBaseArticleShares.shareCode,
            expiresAt: knowledgeBaseArticleShares.expiresAt,
            passwordHash: knowledgeBaseArticleShares.passwordHash,
            isRepost: knowledgeBaseArticleShares.isRepost,
            originalUrl: knowledgeBaseArticleShares.originalUrl,
            originalAuthorName: knowledgeBaseArticleShares.originalAuthorName,
            enabled: knowledgeBaseArticleShares.enabled,
            revokedAt: knowledgeBaseArticleShares.revokedAt,
            score: sql<number>`(
                similarity(${knowledgeBaseArticles.title}, ${keyword}) * 4
                + similarity(coalesce(${knowledgeBaseArticles.publicExcerpt}, ''), ${keyword}) * 2
                + similarity(coalesce(${knowledgeBaseArticles.aiSummary}, ''), ${keyword}) * 2
                + similarity(coalesce(${knowledgeBaseArticles.contentMd}, ''), ${keyword})
            )`.as("score"),
        })
        .from(knowledgeBaseArticleShares)
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleShares.articleId))
        .where(and(
            eq(knowledgeBaseArticleShares.enabled, true),
            isNull(knowledgeBaseArticleShares.revokedAt),
            sql`(
                ${knowledgeBaseArticles.title} ILIKE ${likePattern}
                OR coalesce(${knowledgeBaseArticles.publicExcerpt}, '') ILIKE ${likePattern}
                OR coalesce(${knowledgeBaseArticles.aiSummary}, '') ILIKE ${likePattern}
                OR coalesce(${knowledgeBaseArticles.contentMd}, '') ILIKE ${likePattern}
            )`,
        ))
        .orderBy(sql`score DESC`, desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticleShares.id))
        .limit(input.limit)
        .offset(input.offset)

    const articleIds = rows.map((row) => row.articleId)
    const [tagsByArticle, fallbackMetadataByArticle] = await Promise.all([
        loadTagsByArticleIds(articleIds),
        loadFallbackPublicArticleListMetadata(rows
            .filter((row) => !hasUsablePublicListMetadata(row.publicExcerpt, row.readingMinutes) || !row.publicContentHash?.trim())
            .map((row) => row.articleId)),
    ])

    const items = rows.flatMap((row) => {
        const status = resolvePublicHomepageShareStatus(row, now)
        if (!status.listed) {
            return []
        }
        const fallback = fallbackMetadataByArticle.get(row.articleId)
        const aiSummaryExcerpt = buildArticleAiSummaryExcerpt({
            summary: row.aiSummary,
        })
        return [{
            articleId: String(row.articleId),
            shareCode: row.shareCode,
            title: row.title,
            excerpt: aiSummaryExcerpt || row.publicExcerpt?.trim() || fallback?.publicExcerpt || "暂无摘要",
            updatedAt: formatDate(row.updatedAt),
            readingMinutes: resolveReadingMinutes(row.readingMinutes, fallback?.readingMinutes),
            tags: tagsByArticle.get(row.articleId) ?? [],
            href: `/p/${row.shareCode}`,
            expired: status.expired,
            expiresAt: formatDateOrNull(row.expiresAt),
            hasPassword: status.hasPassword,
            isRepost: buildPublicShareRepostAttribution(row).isRepost,
            score: row.score,
        }]
    })

    return {
        keyword,
        limit: input.limit,
        offset: input.offset,
        items,
        hasMore: items.length === input.limit,
    }
}

function escapeLikePattern(value: string) {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export async function loadPublicArticleListResponse() {
    const now = new Date()
    const rows = await getDb()
        .select({
            articleId: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            updatedAt: knowledgeBaseArticles.updatedAt,
            publicExcerpt: knowledgeBaseArticles.publicExcerpt,
            publicContentHash: knowledgeBaseArticles.publicContentHash,
            aiSummary: knowledgeBaseArticles.aiSummary,
            readingMinutes: knowledgeBaseArticles.readingMinutes,
            shareCode: knowledgeBaseArticleShares.shareCode,
            expiresAt: knowledgeBaseArticleShares.expiresAt,
            passwordHash: knowledgeBaseArticleShares.passwordHash,
            isRepost: knowledgeBaseArticleShares.isRepost,
            originalUrl: knowledgeBaseArticleShares.originalUrl,
            originalAuthorName: knowledgeBaseArticleShares.originalAuthorName,
            enabled: knowledgeBaseArticleShares.enabled,
            revokedAt: knowledgeBaseArticleShares.revokedAt,
        })
        .from(knowledgeBaseArticleShares)
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleShares.articleId))
        .where(and(
            eq(knowledgeBaseArticleShares.enabled, true),
            isNull(knowledgeBaseArticleShares.revokedAt),
        ))
        .orderBy(desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticleShares.id))

    const articleIds = rows.map((row) => row.articleId)
    const [tagsByArticle, fallbackMetadataByArticle] = await Promise.all([
        loadTagsByArticleIds(articleIds),
        loadFallbackPublicArticleListMetadata(rows
            .filter((row) => !hasUsablePublicListMetadata(row.publicExcerpt, row.readingMinutes) || !row.publicContentHash?.trim())
            .map((row) => row.articleId)),
    ])

    return {
        items: rows.flatMap((row) => {
            const status = resolvePublicHomepageShareStatus(row, now)
            if (!status.listed) {
                return []
            }
            const fallback = fallbackMetadataByArticle.get(row.articleId)
            const aiSummaryExcerpt = buildArticleAiSummaryExcerpt({
                summary: row.aiSummary,
            })
            return [{
                articleId: String(row.articleId),
                shareCode: row.shareCode,
                title: row.title,
                excerpt: aiSummaryExcerpt || row.publicExcerpt?.trim() || fallback?.publicExcerpt || "暂无摘要",
                updatedAt: formatDate(row.updatedAt),
                readingMinutes: resolveReadingMinutes(row.readingMinutes, fallback?.readingMinutes),
                tags: tagsByArticle.get(row.articleId) ?? [],
                href: `/p/${row.shareCode}`,
                expired: status.expired,
                expiresAt: formatDateOrNull(row.expiresAt),
                hasPassword: status.hasPassword,
                isRepost: buildPublicShareRepostAttribution(row).isRepost,
            }]
        }),
    }
}

async function loadPublicShareDetailResponse(input: PublicShareDetailLoadInput) {
    const db = getDb()
    const [share] = await db
        .select()
        .from(knowledgeBaseArticleShares)
        .where(and(eq(knowledgeBaseArticleShares.shareCode, input.shareCode), eq(knowledgeBaseArticleShares.enabled, true)))
        .limit(1)

    if (!share) {
        throw notFound("分享不存在或已撤销")
    }
    if (share.expiresAt && share.expiresAt <= new Date()) {
        throw notFound("分享已过期")
    }
    if (share.passwordHash?.trim()) {
        if (!input.allowPassword || !input.accessPassword) {
            throw forbidden("该链接需要访问密码")
        }
        if (!await bcrypt.compare(input.accessPassword, share.passwordHash)) {
            throw forbidden("访问密码错误")
        }
    }

    const [article] = await db
        .select()
        .from(knowledgeBaseArticles)
        .where(eq(knowledgeBaseArticles.id, share.articleId))
        .limit(1)
    if (!article) {
        throw notFound("文章不存在")
    }

    const tags = await loadTags(article.id)
    const currentContentHash = buildPublicArticleContentHash(article.contentMd)
    const usableAiSummary = resolveUsableArticleAiSummary({
        summary: article.aiSummary,
        summaryContentHash: article.aiSummaryContentHash,
        currentContentHash,
    })
    const aiSummary = resolveDisplayArticleAiSummary({ summary: article.aiSummary })
    return {
        title: article.title,
        contentMd: article.contentMd,
        contentJson: article.contentJson,
        contentMetaJson: article.contentMetaJson,
        tocJson: resolvePublicArticleToc(article.contentMd, article.tocJson, article.publicContentHash),
        aiSummary,
        aiSummaryGeneratedAt: aiSummary ? formatDateOrNull(article.aiSummaryGeneratedAt) : null,
        aiSummaryStale: Boolean(aiSummary) && !usableAiSummary,
        tags,
        createdAt: formatDate(article.createdAt),
        updatedAt: formatDate(article.updatedAt),
        ...buildPublicShareRepostAttribution(share),
        mindmapData: parseJsonOrNull(article.mindmapJson),
        mindmapGeneratedAt: formatDateOrNull(article.mindmapGeneratedAt),
        knowledgeGraphData: parseJsonOrNull(article.mindmapKgJson),
        knowledgeGraphGeneratedAt: formatDateOrNull(article.mindmapKgGeneratedAt),
    }
}

function hasUsablePublicListMetadata(publicExcerpt: string | null, readingMinutes: number | null) {
    return Boolean(publicExcerpt?.trim()) && typeof readingMinutes === "number" && Number.isFinite(readingMinutes) && readingMinutes > 0
}

function resolveReadingMinutes(stored: number | null, fallback: number | undefined) {
    if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
        return stored
    }
    return fallback && fallback > 0 ? fallback : 1
}

async function loadFallbackPublicArticleListMetadata(articleIds: number[]) {
    const uniqueArticleIds = [...new Set(articleIds)]
    if (uniqueArticleIds.length === 0) {
        return new Map<number, Pick<ReturnType<typeof buildPublicArticleMetadata>, "publicExcerpt" | "readingMinutes" | "publicContentHash">>()
    }

    const rows = await getDb()
        .select({
            id: knowledgeBaseArticles.id,
            contentMd: knowledgeBaseArticles.contentMd,
        })
        .from(knowledgeBaseArticles)
        .where(inArray(knowledgeBaseArticles.id, uniqueArticleIds))

    return new Map(rows.map((row) => {
        const metadata = buildPublicArticleMetadata(row.contentMd)
        return [row.id, {
            publicExcerpt: metadata.publicExcerpt,
            readingMinutes: metadata.readingMinutes,
            publicContentHash: metadata.publicContentHash,
        }]
    }))
}

async function requireOwner(userId: number, articleId: number) {
    const [row] = await getDb()
        .select({ kb: { userId: knowledgeBases.userId } })
        .from(knowledgeBaseArticles)
        .innerJoin(knowledgeBaseNodes, eq(knowledgeBaseNodes.id, knowledgeBaseArticles.nodeId))
        .innerJoin(knowledgeBases, eq(knowledgeBases.id, knowledgeBaseNodes.knowledgeBaseId))
        .where(eq(knowledgeBaseArticles.id, articleId))
        .limit(1)

    if (!row) {
        throw notFound("文章不存在")
    }
    if (row.kb.userId !== userId) {
        throw forbidden("仅文档拥有者可执行该操作")
    }
}

async function resolvePublicPasswordHash(existing: KnowledgeBaseArticleShareRecord | undefined, passwordEnabled: boolean | null, accessPassword: string) {
    if (passwordEnabled === false) {
        return null
    }
    if (passwordEnabled === true && !accessPassword && !existing?.passwordHash?.trim()) {
        throw badRequest("请填写 6 位访问密码")
    }
    if (!accessPassword) {
        return passwordEnabled === true ? existing?.passwordHash ?? null : null
    }
    return await bcrypt.hash(accessPassword, 10)
}

function buildShareCreateResponse(articleId: number, share: KnowledgeBaseArticleShareRecord) {
    return {
        articleId: String(articleId),
        shareCode: share.shareCode,
        enabled: share.enabled,
        hasPassword: Boolean(share.passwordHash?.trim()),
        expiresAt: formatDateOrNull(share.expiresAt),
        ...buildPublicShareRepostAttribution(share),
        updatedAt: formatDateOrNull(share.updatedAt),
    }
}

async function loadTags(articleId: number) {
    const rows = await getDb()
        .select({ tag: knowledgeBaseArticleTags.tag })
        .from(knowledgeBaseArticleTags)
        .where(eq(knowledgeBaseArticleTags.articleId, articleId))
        .orderBy(asc(knowledgeBaseArticleTags.tag))
    return rows.map((row) => row.tag)
}

async function loadTagsByArticleIds(articleIds: number[]) {
    if (articleIds.length === 0) {
        return new Map<number, string[]>()
    }
    const rows = await getDb()
        .select({ articleId: knowledgeBaseArticleTags.articleId, tag: knowledgeBaseArticleTags.tag })
        .from(knowledgeBaseArticleTags)
        .where(inArray(knowledgeBaseArticleTags.articleId, articleIds))
        .orderBy(asc(knowledgeBaseArticleTags.tag))
    const result = new Map<number, string[]>()
    for (const row of rows) {
        const tags = result.get(row.articleId) ?? []
        tags.push(row.tag)
        result.set(row.articleId, tags)
    }
    return result
}

async function loadNodeMap(knowledgeBaseId: number) {
    const rows = await getDb()
        .select({ id: knowledgeBaseNodes.id, parentId: knowledgeBaseNodes.parentId, name: knowledgeBaseNodes.name })
        .from(knowledgeBaseNodes)
        .where(eq(knowledgeBaseNodes.knowledgeBaseId, knowledgeBaseId))
    return new Map(rows.map((node) => [node.id, node]))
}

function generateShareCode() {
    return randomBytes(18).toString("base64url")
}

function parseJsonOrNull(value: string | null | undefined) {
    const text = value?.trim() ?? ""
    if (!text) {
        return null
    }
    try {
        return JSON.parse(text) as unknown
    } catch {
        return null
    }
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function formatDateOrNull(value: Date | string | null | undefined) {
    if (!value) {
        return null
    }
    return formatDate(value)
}
