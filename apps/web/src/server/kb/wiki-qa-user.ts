import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBaseWikiLinks,
    knowledgeBaseWikiPages,
    knowledgeBaseWikiSourceRefs,
    type KnowledgeBaseWikiPageRecord,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import {
    groupWikiOverviewPages,
    rankWikiPagesForQueries,
    readFrontmatterAliases,
    summarizeWikiContent,
    toWikiQaCard,
    type WikiQaNeighborPage,
    type WikiQaOverviewGroup,
    type WikiQaPageDetail,
    type WikiQaSearchHit,
} from "@/server/kb/wiki-qa-core"

/**
 * 后台助手 Wiki 问答的检索层（作用域 = 当前用户自己的知识库页面）。
 * 与公开层共用 wiki-qa-core 的打分/概览逻辑，差异只在可达范围与来源文章链接。
 */

/** 用户名下全部可用页面（跨库；log 页不参与）。 */
export async function listUserAccessibleWikiPages(
    userId: number,
    knowledgeBaseId?: number | null,
): Promise<KnowledgeBaseWikiPageRecord[]> {
    const filters = [
        eq(knowledgeBaseWikiPages.userId, userId),
        isNull(knowledgeBaseWikiPages.archivedAt),
    ]
    if (knowledgeBaseId != null) {
        filters.push(eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId))
    }
    const rows = await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(...filters))
    return rows.filter((page) => page.kind !== "log")
}

export type UserWikiMentionTarget = {
    pageKey: string
    title: string
    aliases: string[]
    kind: "concept" | "entity"
}

/**
 * 普通问答正文的 Wiki 标注词典。
 *
 * 与 Wiki 问答使用同一张 knowledgeBaseWikiPages 表，但只取实体/概念的寻址字段，
 * 不加载正文。未聚焦知识库时覆盖用户名下全部 Wiki；同 pageKey 与详情接口一样
 * 以最早创建的页面为准，并把其他库里的同名标题/别名并入可匹配词。
 */
export async function listUserWikiMentionTargets(input: {
    userId: number
    knowledgeBaseId?: number | null
}): Promise<UserWikiMentionTarget[]> {
    const filters = [
        eq(knowledgeBaseWikiPages.userId, input.userId),
        isNull(knowledgeBaseWikiPages.archivedAt),
        inArray(knowledgeBaseWikiPages.kind, ["concept", "entity"]),
    ]
    if (input.knowledgeBaseId != null) {
        filters.push(eq(knowledgeBaseWikiPages.knowledgeBaseId, input.knowledgeBaseId))
    }
    const rows = await getDb()
        .select({
            id: knowledgeBaseWikiPages.id,
            pageKey: knowledgeBaseWikiPages.pageKey,
            title: knowledgeBaseWikiPages.title,
            kind: knowledgeBaseWikiPages.kind,
            frontmatterJson: knowledgeBaseWikiPages.frontmatterJson,
        })
        .from(knowledgeBaseWikiPages)
        .where(and(...filters))
        .orderBy(asc(knowledgeBaseWikiPages.id))

    const byPageKey = new Map<string, UserWikiMentionTarget>()
    for (const row of rows) {
        const aliases = readFrontmatterAliases(row.frontmatterJson)
        const current = byPageKey.get(row.pageKey)
        if (current) {
            current.aliases = [...new Set([
                ...current.aliases,
                ...(row.title !== current.title ? [row.title] : []),
                ...aliases,
            ])]
            continue
        }
        byPageKey.set(row.pageKey, {
            pageKey: row.pageKey,
            title: row.title,
            aliases,
            kind: row.kind === "concept" ? "concept" : "entity",
        })
    }
    return [...byPageKey.values()]
}

export async function listUserWikiOverview(input: {
    userId: number
    knowledgeBaseId?: number | null
}): Promise<{
    groups: WikiQaOverviewGroup[]
    total: number
}> {
    const pages = await listUserAccessibleWikiPages(input.userId, input.knowledgeBaseId)
    return groupWikiOverviewPages(pages)
}

export async function searchUserWikiPages(input: {
    userId: number
    queries: string[]
    limit?: number
    knowledgeBaseId?: number | null
}): Promise<{ query: string[]; items: WikiQaSearchHit[] }> {
    const queries = input.queries.map((query) => query.trim()).filter(Boolean).slice(0, 6)
    if (queries.length === 0) {
        throw badRequest("至少提供一个搜索关键词")
    }
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)
    const pages = await listUserAccessibleWikiPages(input.userId, input.knowledgeBaseId)
    if (pages.length === 0) return { query: queries, items: [] }
    return { query: queries, items: rankWikiPagesForQueries(pages, queries, limit) }
}

/**
 * 读取用户自己的 Wiki 页面详情。pageKey 在用户多个库里可能同名：
 * 指定了 knowledgeBaseId 时优先命中该库，否则取最早创建的页面。
 */
export async function readUserWikiPageDetail(input: {
    userId: number
    pageKey: string
    knowledgeBaseId?: number | null
}): Promise<WikiQaPageDetail> {
    const trimmed = input.pageKey.trim()
    if (!trimmed) throw badRequest("pageKey 不能为空")

    const rows = await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, input.userId),
            eq(knowledgeBaseWikiPages.pageKey, trimmed),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))
        .orderBy(asc(knowledgeBaseWikiPages.id))
    if (rows.length === 0) throw notFound("Wiki 页面不存在")
    const page = input.knowledgeBaseId != null
        ? rows.find((row) => row.knowledgeBaseId === input.knowledgeBaseId) ?? rows[0]
        : rows[0]

    const [links, inLinkRows] = await Promise.all([
        getDb()
            .select()
            .from(knowledgeBaseWikiLinks)
            .where(eq(knowledgeBaseWikiLinks.fromPageId, page.id))
            .orderBy(asc(knowledgeBaseWikiLinks.id)),
        getDb()
            .select()
            .from(knowledgeBaseWikiLinks)
            .where(and(
                eq(knowledgeBaseWikiLinks.userId, page.userId),
                eq(knowledgeBaseWikiLinks.knowledgeBaseId, page.knowledgeBaseId),
                eq(knowledgeBaseWikiLinks.toPageKey, page.pageKey),
            ))
            .orderBy(asc(knowledgeBaseWikiLinks.fromPageId)),
    ])

    const neighborIds = [...new Set(inLinkRows.map((link) => link.fromPageId))]
    const outTargets = [...new Set(links.map((link) => link.toPageKey))]
    const [neighborRows, outTargetRows] = await Promise.all([
        neighborIds.length === 0
            ? []
            : getDb()
                .select()
                .from(knowledgeBaseWikiPages)
                .where(and(inArray(knowledgeBaseWikiPages.id, neighborIds), isNull(knowledgeBaseWikiPages.archivedAt))),
        outTargets.length === 0
            ? []
            : getDb()
                .select()
                .from(knowledgeBaseWikiPages)
                .where(and(
                    inArray(knowledgeBaseWikiPages.pageKey, outTargets),
                    eq(knowledgeBaseWikiPages.knowledgeBaseId, page.knowledgeBaseId),
                    isNull(knowledgeBaseWikiPages.archivedAt),
                )),
    ])
    const neighborById = new Map(neighborRows.map((row) => [row.id, row]))
    const outByKey = new Map(outTargetRows.map((row) => [row.pageKey, row]))

    const toNeighbor = (
        target: { pageKey: string; linkType: string },
        resolved: KnowledgeBaseWikiPageRecord | undefined,
    ): WikiQaNeighborPage => ({
        pageKey: target.pageKey,
        title: resolved?.title ?? target.pageKey,
        kind: resolved?.kind ?? null,
        summary: resolved?.summary?.trim() || (resolved ? summarizeWikiContent(resolved.contentMd, 120) : null),
        linkType: target.linkType,
    })

    const sourceRefRows = await getDb()
        .select({
            articleId: knowledgeBaseWikiSourceRefs.articleId,
            anchor: knowledgeBaseWikiSourceRefs.anchor,
            note: knowledgeBaseWikiSourceRefs.note,
        })
        .from(knowledgeBaseWikiSourceRefs)
        .where(eq(knowledgeBaseWikiSourceRefs.pageId, page.id))
    const articleIds = sourceRefRows.map((ref) => ref.articleId)
    const articleRows = articleIds.length === 0
        ? []
        : await getDb()
            .select({ id: knowledgeBaseArticles.id, title: knowledgeBaseArticles.title })
            .from(knowledgeBaseArticles)
            .where(inArray(knowledgeBaseArticles.id, articleIds))
    const titleByArticleId = new Map(articleRows.map((row) => [row.id, row.title]))

    return {
        ...toWikiQaCard(page),
        contentMd: page.contentMd,
        links: links
            .map((link) => toNeighbor({ pageKey: link.toPageKey, linkType: link.linkType }, outByKey.get(link.toPageKey))),
        inLinks: inLinkRows
            .map((link) => toNeighbor(
                { pageKey: neighborById.get(link.fromPageId)?.pageKey ?? "", linkType: link.linkType },
                neighborById.get(link.fromPageId),
            ))
            .filter((neighbor) => neighbor.pageKey !== ""),
        sourceArticles: sourceRefRows
            .filter((ref) => titleByArticleId.has(ref.articleId))
            .map((ref) => ({
                articleId: String(ref.articleId),
                title: titleByArticleId.get(ref.articleId)!,
                href: knowledgeBaseArticlePath(String(page.knowledgeBaseId), String(ref.articleId)),
                note: ref.note,
            })),
    }
}
