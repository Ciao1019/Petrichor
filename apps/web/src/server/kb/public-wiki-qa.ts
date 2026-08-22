import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseWikiLinks,
    knowledgeBaseWikiPages,
    knowledgeBaseWikiSourceRefs,
    type KnowledgeBaseWikiPageRecord,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import type { PublicArticleScope } from "@/server/kb/public-qa-logic"
import { buildPublicArticleHref } from "@/server/kb/public-qa-logic"
import {
    groupWikiOverviewPages,
    rankWikiPagesForQueries,
    summarizeWikiContent,
    toWikiQaCard,
    type WikiQaNeighborPage,
} from "@/server/kb/wiki-qa-core"

/**
 * 公开 Wiki 问答的检索层（前台 /ask，作用域 = 关联到「公开分享」文章的页面）。
 * 打分/摘要/概览等纯逻辑见 wiki-qa-core.ts；后台助手的作用域变体见 wiki-qa-user.ts。
 */

export interface PublicWikiPageCard {
    pageKey: string
    title: string
    kind: string
    summary: string
    aliases: string[]
}

export interface PublicWikiSearchHit extends PublicWikiPageCard {
    snippet: string
}

export interface PublicWikiOverviewGroup {
    key: "sources" | "topics"
    label: string
    pages: PublicWikiPageCard[]
}

export type PublicWikiNeighborPage = WikiQaNeighborPage

export interface PublicWikiPageDetail extends PublicWikiPageCard {
    contentMd: string
    links: PublicWikiNeighborPage[]
    inLinks: PublicWikiNeighborPage[]
    sourceArticles: Array<{
        articleId: string
        title: string
        href: string
        note: string | null
    }>
}

/**
 * 加载全部「公开可达」的 Wiki 页面：
 * sourceRefs 命中公开文章的页面直接可达；index 页在其知识库有公开文章时附带返回。
 */
async function loadAccessiblePublicWikiPages(scope: PublicArticleScope) {
    if (scope.size === 0) return { direct: [] as KnowledgeBaseWikiPageRecord[] }

    const articleIds = [...scope.keys()]
    const refRows = await getDb()
        .select({ pageId: knowledgeBaseWikiSourceRefs.pageId })
        .from(knowledgeBaseWikiSourceRefs)
        .where(inArray(knowledgeBaseWikiSourceRefs.articleId, articleIds))
    const pageIds = [...new Set(refRows.map((row) => row.pageId))]

    const direct = pageIds.length === 0
        ? []
        : await getDb()
            .select()
            .from(knowledgeBaseWikiPages)
            .where(and(
                inArray(knowledgeBaseWikiPages.id, pageIds),
                isNull(knowledgeBaseWikiPages.archivedAt),
            ))

    // index 页没有 sourceRefs：其知识库下只要有任一公开文章即视为可达。
    const kbIds = [...new Set(direct.map((page) => page.knowledgeBaseId))]
    const indexPages = kbIds.length === 0
        ? []
        : await getDb()
            .select({ id: knowledgeBaseWikiPages.id })
            .from(knowledgeBaseWikiPages)
            .where(and(
                inArray(knowledgeBaseWikiPages.knowledgeBaseId, kbIds),
                eq(knowledgeBaseWikiPages.kind, "index"),
                isNull(knowledgeBaseWikiPages.archivedAt),
            ))
    const indexIds = indexPages.map((page) => page.id)
    const indexRows = indexIds.length === 0
        ? []
        : await getDb()
            .select()
            .from(knowledgeBaseWikiPages)
            .where(inArray(knowledgeBaseWikiPages.id, indexIds))

    return { direct: [...direct, ...indexRows] }
}

/**
 * Wiki 总览：源文档页 + 主题知识页两组，按更新时间倒序。
 * 对齐 WeKnora 的索引概览思路——先看目录再决定读哪页。
 */
export async function listPublicWikiOverview(scope: PublicArticleScope): Promise<{
    groups: PublicWikiOverviewGroup[]
    total: number
}> {
    const { direct } = await loadAccessiblePublicWikiPages(scope)
    const grouped = groupWikiOverviewPages(direct)
    return grouped
}

/**
 * 多关键词 Wiki 检索：每个词独立打分后合并取最好成绩，
 * 标题命中权重最高，别名/摘要次之，正文命中附上前后文片段。
 */
export async function searchPublicWikiPages(input: {
    scope: PublicArticleScope
    queries: string[]
    limit?: number
}): Promise<{ query: string[]; items: PublicWikiSearchHit[] }> {
    const queries = input.queries.map((query) => query.trim()).filter(Boolean).slice(0, 6)
    if (queries.length === 0) {
        throw badRequest("至少提供一个搜索关键词")
    }
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)

    const { direct } = await loadAccessiblePublicWikiPages(input.scope)
    const searchable = direct.filter((page) => page.kind !== "log")
    if (searchable.length === 0) return { query: queries, items: [] }

    const items = rankWikiPagesForQueries(searchable, queries, limit)
    return { query: queries, items }
}

/**
 * 按 pageKey 校验「公开可达」并返回目标页面；index 页在其知识库有公开文章时放行。
 * 供公开问答的读取工具在做正文读取前先行做白名单判定（主题页 pageKey 不含文章 id，
 * 无法靠读取结果的 articleId 归属校验）。
 */
export async function assertPublicWikiPageAccessible(
    scope: PublicArticleScope,
    pageKey: string,
): Promise<KnowledgeBaseWikiPageRecord> {
    return await resolveAccessiblePage(scope, pageKey)
}

/** 按 pageKey 找到公开可达的目标页面；index 页在知识库有公开文章时放行。 */
async function resolveAccessiblePage(
    scope: PublicArticleScope,
    pageKey: string,
): Promise<KnowledgeBaseWikiPageRecord> {
    const rows = await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.pageKey, pageKey),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))
        .orderBy(asc(knowledgeBaseWikiPages.id))
    if (rows.length === 0) throw notFound("Wiki 页面不存在")

    const pageIds = rows.map((page) => page.id)
    const refRows = pageIds.length === 0
        ? []
        : await getDb()
            .select({ pageId: knowledgeBaseWikiSourceRefs.pageId, articleId: knowledgeBaseWikiSourceRefs.articleId })
            .from(knowledgeBaseWikiSourceRefs)
            .where(inArray(knowledgeBaseWikiSourceRefs.pageId, pageIds))

    const publicArticleIds = new Set(scope.keys())
    const accessibleIds = new Set(
        refRows
            .filter((ref) => publicArticleIds.has(ref.articleId))
            .map((ref) => ref.pageId),
    )
    const direct = rows.find((page) => accessibleIds.has(page.id))
    if (direct) return direct

    // index 页特例：其知识库下存在任何公开文章即可读（目录不含敏感正文）。
    const indexCandidate = rows.find((page) => page.kind === "index")
    if (indexCandidate) {
        const kbPublic = refRows.some((ref) => {
            const article = scope.get(ref.articleId)
            return article
                && article.userId === indexCandidate.userId
                && article.knowledgeBaseId === indexCandidate.knowledgeBaseId
        })
        if (kbPublic) return indexCandidate
    }

    throw notFound("该 Wiki 页面不在公开范围内")
}

/** 读取页面详情：全文 + 出入链邻居摘要 + 来源文章（WeKnora 式 relationships）。 */
export async function readPublicWikiPageDetail(
    scope: PublicArticleScope,
    pageKey: string,
): Promise<PublicWikiPageDetail> {
    const trimmed = pageKey.trim()
    if (!trimmed) throw badRequest("pageKey 不能为空")
    const page = await resolveAccessiblePage(scope, trimmed)

    const links = await getDb()
        .select()
        .from(knowledgeBaseWikiLinks)
        .where(eq(knowledgeBaseWikiLinks.fromPageId, page.id))
        .orderBy(asc(knowledgeBaseWikiLinks.id))
    const inLinkRows = await getDb()
        .select()
        .from(knowledgeBaseWikiLinks)
        .where(and(
            eq(knowledgeBaseWikiLinks.userId, page.userId),
            eq(knowledgeBaseWikiLinks.knowledgeBaseId, page.knowledgeBaseId),
            eq(knowledgeBaseWikiLinks.toPageKey, page.pageKey),
        ))
        .orderBy(asc(knowledgeBaseWikiLinks.fromPageId))

    const [neighborRows, outTargetRows] = await Promise.all([
        loadLinkNeighborPages([...new Set(inLinkRows.map((link) => link.fromPageId))]),
        loadOutTargetPages(page.knowledgeBaseId, [...new Set(links.map((link) => link.toPageKey))]),
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
    const sourceArticles = sourceRefRows
        .map((ref) => ({ ref, scopeRef: scope.get(ref.articleId) }))
        .filter((item): item is typeof item & { scopeRef: NonNullable<typeof item.scopeRef> } => Boolean(item.scopeRef))
        .map(({ ref, scopeRef }) => ({
            articleId: String(ref.articleId),
            title: scopeRef.title,
            href: buildPublicArticleHref(scopeRef.shareCode),
            note: ref.note,
        }))

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
        sourceArticles,
    }
}

async function loadLinkNeighborPages(pageIds: number[]) {
    if (pageIds.length === 0) return []
    return await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(inArray(knowledgeBaseWikiPages.id, pageIds), isNull(knowledgeBaseWikiPages.archivedAt)))
}

async function loadOutTargetPages(knowledgeBaseId: number, pageKeys: string[]) {
    if (pageKeys.length === 0) return []
    return await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            inArray(knowledgeBaseWikiPages.pageKey, pageKeys),
            eq(knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            isNull(knowledgeBaseWikiPages.archivedAt),
        ))
}
