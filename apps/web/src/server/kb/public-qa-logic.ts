import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticleShares,
    knowledgeBaseArticles,
    knowledgeBaseWikiTreeNodes,
    users,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { resolvePublicHomepageShareStatus } from "@/server/kb/share-logic"
import { buildArticleAiSummaryExcerpt } from "@/server/kb/article-summary-logic"
import {
    readSourceArticleForAgent,
    readWikiPageForAgent,
} from "@/server/kb/wiki-agent-logic"
import { readTreeNodeForAgent, retrieveTreeNodesForAgent } from "@/server/kb/wiki-tree"

/** 一篇公开（已分享、未撤销、未过期、无密码）文章的归属信息。 */
export interface PublicArticleRef {
    articleId: number
    userId: number
    knowledgeBaseId: number
    shareCode: string
    title: string
}

export type PublicArticleScope = Map<number, PublicArticleRef>

/**
 * SQL 层可见性：永久分享已启用、未撤销、无密码、未过期。
 * 应用层仍用 resolvePublicHomepageShareStatus 再滤一遍，双保险。
 */
export function publicShareVisibilitySql(now = new Date()) {
    return and(
        eq(knowledgeBaseArticleShares.enabled, true),
        isNull(knowledgeBaseArticleShares.revokedAt),
        sql`(
            ${knowledgeBaseArticleShares.passwordHash} is null
            or btrim(${knowledgeBaseArticleShares.passwordHash}) = ''
        )`,
        or(
            isNull(knowledgeBaseArticleShares.expiresAt),
            sql`${knowledgeBaseArticleShares.expiresAt} > ${now}`,
        ),
    )
}

/** 站长 = 首个 SUPER_ADMIN，其默认 AI 配置用于驱动公开问答模型。 */
export async function getSiteOwnerUserId(): Promise<number | null> {
    const [row] = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.systemRole, "SUPER_ADMIN"))
        .orderBy(asc(users.id))
        .limit(1)
    return row?.id ?? null
}

/**
 * 加载当前所有「公开可访问」的文章作用域：已启用分享、未撤销、未过期、且无访问密码。
 * 这是公开问答全部检索/读取工具的唯一可达边界。
 */
export async function loadPublicArticleScope(now = new Date()): Promise<PublicArticleScope> {
    const rows = await getDb()
        .select({
            articleId: knowledgeBaseArticles.id,
            userId: knowledgeBaseArticles.userId,
            knowledgeBaseId: knowledgeBaseArticles.knowledgeBaseId,
            title: knowledgeBaseArticles.title,
            shareCode: knowledgeBaseArticleShares.shareCode,
            enabled: knowledgeBaseArticleShares.enabled,
            revokedAt: knowledgeBaseArticleShares.revokedAt,
            expiresAt: knowledgeBaseArticleShares.expiresAt,
            passwordHash: knowledgeBaseArticleShares.passwordHash,
        })
        .from(knowledgeBaseArticleShares)
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleShares.articleId))
        .where(publicShareVisibilitySql(now))

    const scope: PublicArticleScope = new Map()
    for (const row of rows) {
        const status = resolvePublicHomepageShareStatus(row, now)
        // 公开问答排除：未列出 / 已过期 / 带密码 的分享。
        if (!status.listed || status.expired || status.hasPassword) continue
        scope.set(row.articleId, {
            articleId: row.articleId,
            userId: row.userId,
            knowledgeBaseId: row.knowledgeBaseId,
            shareCode: row.shareCode,
            title: row.title,
        })
    }
    return scope
}

/** 公开文章详情页路径，用于引用卡片 href。 */
export function buildPublicArticleHref(shareCode: string): string {
    return `/p/${shareCode}`
}

function escapeLikePattern(value: string) {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export interface PublicArticleSearchHit {
    articleId: string
    shareCode: string
    href: string
    title: string
    snippet: string
    updatedAt: string
}

export interface PublicArticleListItem {
    articleId: string
    shareCode: string
    href: string
    title: string
    snippet: string
    updatedAt: string
}

/**
 * 列出当前全部「公开可访问」文章（与 loadPublicArticleScope 同一边界），按更新时间倒序。
 * 用于「有哪些公开文章」类概览问题；带关键词的内容检索仍用 searchPublicArticles。
 */
export async function listPublicArticles(input: {
    limit?: number
    offset?: number
} = {}, now = new Date()): Promise<{
    total: number
    items: PublicArticleListItem[]
}> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 50)
    const offset = Math.max(input.offset ?? 0, 0)

    const rows = await getDb()
        .select({
            articleId: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            updatedAt: knowledgeBaseArticles.updatedAt,
            publicExcerpt: knowledgeBaseArticles.publicExcerpt,
            aiSummary: knowledgeBaseArticles.aiSummary,
            shareCode: knowledgeBaseArticleShares.shareCode,
            enabled: knowledgeBaseArticleShares.enabled,
            revokedAt: knowledgeBaseArticleShares.revokedAt,
            expiresAt: knowledgeBaseArticleShares.expiresAt,
            passwordHash: knowledgeBaseArticleShares.passwordHash,
            pinOrder: knowledgeBaseArticleShares.pinOrder,
        })
        .from(knowledgeBaseArticleShares)
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleShares.articleId))
        .where(publicShareVisibilitySql(now))
        .orderBy(
            sql`${knowledgeBaseArticleShares.pinOrder} IS NULL`,
            desc(knowledgeBaseArticleShares.pinOrder),
            desc(knowledgeBaseArticles.updatedAt),
            desc(knowledgeBaseArticleShares.id),
        )

    const visible: PublicArticleListItem[] = []
    for (const row of rows) {
        const status = resolvePublicHomepageShareStatus(row, now)
        if (!status.listed || status.expired || status.hasPassword) continue
        const snippet = buildArticleAiSummaryExcerpt({ summary: row.aiSummary })
            || row.publicExcerpt?.trim()
            || ""
        visible.push({
            articleId: String(row.articleId),
            shareCode: row.shareCode,
            href: buildPublicArticleHref(row.shareCode),
            title: row.title,
            snippet,
            updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
        })
    }

    return {
        total: visible.length,
        items: visible.slice(offset, offset + limit),
    }
}

/**
 * 在公开文章里检索（标题 / 摘要 / AI 摘要 / 正文，pg_trgm 相似度 + ILIKE 排序），
 * 思路对齐 share-handlers 的 loadPublicArticleSearchResponse，但只返回问答所需字段。
 */
export async function searchPublicArticles(input: {
    query: string
    limit?: number
}, now = new Date()): Promise<PublicArticleSearchHit[]> {
    const keyword = input.query.trim()
    if (!keyword) return []
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)
    const likePattern = `%${escapeLikePattern(keyword)}%`

    const rows = await getDb()
        .select({
            articleId: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            updatedAt: knowledgeBaseArticles.updatedAt,
            publicExcerpt: knowledgeBaseArticles.publicExcerpt,
            aiSummary: knowledgeBaseArticles.aiSummary,
            shareCode: knowledgeBaseArticleShares.shareCode,
            enabled: knowledgeBaseArticleShares.enabled,
            revokedAt: knowledgeBaseArticleShares.revokedAt,
            expiresAt: knowledgeBaseArticleShares.expiresAt,
            passwordHash: knowledgeBaseArticleShares.passwordHash,
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
            publicShareVisibilitySql(now),
            sql`(
                ${knowledgeBaseArticles.title} ILIKE ${likePattern}
                OR coalesce(${knowledgeBaseArticles.publicExcerpt}, '') ILIKE ${likePattern}
                OR coalesce(${knowledgeBaseArticles.aiSummary}, '') ILIKE ${likePattern}
                OR coalesce(${knowledgeBaseArticles.contentMd}, '') ILIKE ${likePattern}
            )`,
        ))
        .orderBy(sql`score DESC`, desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticleShares.id))
        .limit(limit * 3)

    const hits: PublicArticleSearchHit[] = []
    for (const row of rows) {
        const status = resolvePublicHomepageShareStatus(row, now)
        if (!status.listed || status.expired || status.hasPassword) continue
        const snippet = buildArticleAiSummaryExcerpt({ summary: row.aiSummary })
            || row.publicExcerpt?.trim()
            || "（无摘要，可调用 read_source_article 查看全文）"
        hits.push({
            articleId: String(row.articleId),
            shareCode: row.shareCode,
            href: buildPublicArticleHref(row.shareCode),
            title: row.title,
            snippet,
            updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
        })
        if (hits.length >= limit) break
    }
    return hits
}

function requirePublicArticle(scope: PublicArticleScope, articleId: number): PublicArticleRef {
    const ref = scope.get(articleId)
    if (!ref) {
        throw notFound("该文章不在公开范围内（仅支持已公开分享的文章）")
    }
    return ref
}

function parseSourcePageKey(pageKey: string): number | null {
    const match = pageKey.match(/^source-(\d+)$/)
    return match ? Number(match[1]) : null
}

/** 推理式目录树检索——必须指定一篇公开文章，委托后台的 retrieveTreeNodesForAgent。 */
export async function retrievePublicTreeNodes(input: {
    scope: PublicArticleScope
    articleId: number
    query: string
    limit?: number
}) {
    const ref = requirePublicArticle(input.scope, input.articleId)
    return await retrieveTreeNodesForAgent({
        userId: ref.userId,
        knowledgeBaseId: ref.knowledgeBaseId,
        query: input.query,
        limit: input.limit,
        articleId: input.articleId,
    })
}

/** 读取目录节点全文——按 nodeKey 解析归属并校验文章公开，委托 readTreeNodeForAgent。 */
export async function readPublicTreeNode(scope: PublicArticleScope, nodeKey: string) {
    const rows = await getDb()
        .select({
            userId: knowledgeBaseWikiTreeNodes.userId,
            knowledgeBaseId: knowledgeBaseWikiTreeNodes.knowledgeBaseId,
            articleId: knowledgeBaseWikiTreeNodes.articleId,
        })
        .from(knowledgeBaseWikiTreeNodes)
        .where(eq(knowledgeBaseWikiTreeNodes.nodeKey, nodeKey))
    const match = rows.find((row) => scope.has(row.articleId))
    if (!match) {
        throw notFound("目录节点不存在或不在公开范围内")
    }
    return await readTreeNodeForAgent(match.userId, match.knowledgeBaseId, nodeKey)
}

/** 读取文章级 Wiki 页面（仅 source-<id>），校验文章公开后委托 readWikiPageForAgent。 */
export async function readPublicWikiPage(scope: PublicArticleScope, pageKey: string) {
    const articleId = parseSourcePageKey(pageKey)
    if (articleId == null) {
        throw badRequest("公开问答仅支持读取文章级 Wiki 页面（pageKey 形如 source-<articleId>）")
    }
    const ref = requirePublicArticle(scope, articleId)
    return await readWikiPageForAgent(ref.userId, ref.knowledgeBaseId, pageKey)
}

/** 读取源文档全文，校验文章公开后委托 readSourceArticleForAgent，并附带公开 href。 */
export async function readPublicSourceArticle(scope: PublicArticleScope, articleId: number) {
    const ref = requirePublicArticle(scope, articleId)
    const result = await readSourceArticleForAgent(ref.userId, ref.knowledgeBaseId, articleId)
    return { ...result, shareCode: ref.shareCode, href: buildPublicArticleHref(ref.shareCode) }
}
