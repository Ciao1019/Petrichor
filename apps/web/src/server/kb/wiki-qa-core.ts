import type { KnowledgeBaseWikiPageRecord } from "@/server/db/schema"

/**
 * Wiki 问答检索的纯函数核心（参考 Tencent/WeKnora 的 wiki_search / wiki_read_page 设计）。
 *
 * 公开问答与后台助手两种作用域共用这里的打分、摘要、命中片段和概览分组逻辑：
 * - 概览：分组列出源文档页与主题知识页（含摘要），让模型先掌握全貌再深入；
 * - 搜索：多关键词一次搜多个概念，命中标题/摘要/别名/正文，返回页卡 + 命中片段；
 * - 读页：页面全文 + 出入链邻居摘要 + 来源文章，模型可顺藤摸瓜读关联页面。
 *
 * 作用域差异只在「哪些页面可达」和「来源文章的标题/链接解析」，
 * 由各调用方先取好页面记录再进来。
 */

export interface WikiQaPageCard {
    pageKey: string
    title: string
    kind: string
    summary: string
    aliases: string[]
}

export interface WikiQaSearchHit extends WikiQaPageCard {
    snippet: string
}

export interface WikiQaOverviewGroup {
    key: "sources" | "topics"
    label: string
    pages: WikiQaPageCard[]
}

export interface WikiQaNeighborPage {
    pageKey: string
    title: string
    kind: string | null
    summary: string | null
    linkType: string
}

/** 来源文章信息由调用方按作用域解析（公开站用 shareCode 链接，后台用 dashboard 路由）。 */
export interface WikiQaSourceArticle {
    articleId: string
    title: string
    href: string
    note: string | null
}

export interface WikiQaPageDetail extends WikiQaPageCard {
    contentMd: string
    links: WikiQaNeighborPage[]
    inLinks: WikiQaNeighborPage[]
    sourceArticles: WikiQaSourceArticle[]
}

const TOPIC_KINDS = new Set(["concept", "entity", "comparison", "answer"])

export function isWikiTopicKind(kind: string): boolean {
    return TOPIC_KINDS.has(kind)
}

export function readFrontmatterAliases(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw) as { aliases?: unknown }
        if (!Array.isArray(parsed?.aliases)) return []
        return parsed.aliases.map((value) => String(value).trim()).filter(Boolean)
    } catch {
        return []
    }
}

export function summarizeWikiContent(contentMd: string, maxLength: number) {
    const text = contentMd
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[#>*_`~-]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/** 从正文中提取关键词命中的前后文片段（对齐 WeKnora 的 match_snippet）。 */
export function extractWikiMatchSnippet(contentMd: string, keyword: string, radius = 70): string {
    if (!keyword) return ""
    const haystack = contentMd.replace(/```[\s\S]*?```/g, " ")
    const lower = haystack.toLowerCase()
    const index = lower.indexOf(keyword.toLowerCase())
    if (index < 0) return ""
    const start = Math.max(0, index - radius)
    const end = Math.min(haystack.length, index + keyword.length + radius)
    const prefix = start > 0 ? "…" : ""
    const suffix = end < haystack.length ? "…" : ""
    return `${prefix}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`
}

export function toWikiQaCard(page: KnowledgeBaseWikiPageRecord): WikiQaPageCard {
    return {
        pageKey: page.pageKey,
        title: page.title,
        kind: page.kind,
        summary: page.summary?.trim() || summarizeWikiContent(page.contentMd, 160),
        aliases: readFrontmatterAliases(page.frontmatterJson),
    }
}

/**
 * 多关键词打分：每个词独立算分后取该页面最好成绩，
 * 标题命中权重最高，别名/摘要次之，正文命中附上前后文片段。
 */
export function rankWikiPagesForQueries(
    pages: KnowledgeBaseWikiPageRecord[],
    queries: string[],
    limit: number,
): WikiQaSearchHit[] {
    const scored: Array<{ page: KnowledgeBaseWikiPageRecord; score: number; snippet: string }> = []
    for (const page of pages) {
        const card = toWikiQaCard(page)
        const contentFlat = summarizeWikiContent(page.contentMd, 4000)
        let best: { score: number; snippet: string } | null = null
        for (const query of queries) {
            const normalized = query.trim().toLowerCase()
            if (!normalized) continue
            let score = 0
            let snippet = ""
            if (card.title.toLowerCase().includes(normalized)) score += 4
            if (card.summary.toLowerCase().includes(normalized)) score += 2
            if (card.aliases.some((alias) => alias.toLowerCase().includes(normalized))) score += 2
            if (contentFlat.toLowerCase().includes(normalized)) {
                score += 1
                snippet = extractWikiMatchSnippet(page.contentMd, query.trim())
            }
            if (score > 0 && (!best || score > best.score)) best = { score, snippet }
        }
        if (best) scored.push({ page, ...best })
    }

    return scored
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ page, snippet }) => ({
            ...toWikiQaCard(page),
            snippet: snippet || summarizeWikiContent(page.contentMd, 140),
        }))
}

/** 概览分组：主题知识页在前、源文档页在后，各自按更新时间倒序。 */
export function groupWikiOverviewPages(
    pages: KnowledgeBaseWikiPageRecord[],
): { groups: WikiQaOverviewGroup[]; total: number } {
    const sources: KnowledgeBaseWikiPageRecord[] = []
    const topics: KnowledgeBaseWikiPageRecord[] = []
    for (const page of pages) {
        if (isWikiTopicKind(page.kind)) topics.push(page)
        else if (page.kind === "source") sources.push(page)
    }
    const byUpdatedDesc = (left: KnowledgeBaseWikiPageRecord, right: KnowledgeBaseWikiPageRecord) =>
        right.updatedAt.getTime() - left.updatedAt.getTime()
    sources.sort(byUpdatedDesc)
    topics.sort(byUpdatedDesc)

    return {
        groups: [
            { key: "topics", label: "主题与知识", pages: topics.map(toWikiQaCard) },
            { key: "sources", label: "源文档", pages: sources.map(toWikiQaCard) },
        ],
        total: sources.length + topics.length,
    }
}
