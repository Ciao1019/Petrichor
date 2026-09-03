import type { PublicSearchMode, PublicSearchResponse, PublicSearchResult, PublicSearchType } from "@/lib/api"

import { buildDemoPublicArticleList, findDemoPublicArticle } from "./demo-public-data"
import { demoStore } from "./demo-store"
import { demoPublicWikiKnowledgeBases, demoPublicWikiPageList } from "./demo-wiki"

const semanticAliases: Record<string, string[]> = {
  清理: ["mole", "卸载", "缓存", "安全", "dry-run"],
  系统信息: ["fastfetch", "硬件", "操作系统", "终端"],
  配置: ["jsonc", "模块", "自定义"],
  安全: ["白名单", "预览", "备份", "清理"],
  检索: ["rag", "搜索", "召回", "向量"],
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function snippets(text: string, query: string, limit = 180) {
  const compact = text
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, pageKey: string, alias?: string) => alias || pageKey)
    .replace(/[#>*_`|()!-]+/g, " ")
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replace(/\s+/g, " ")
    .trim()
  const index = compact.toLowerCase().indexOf(query.toLowerCase())
  const start = index > 40 ? index - 40 : 0
  const value = compact.slice(start, start + limit)
  return start > 0 ? `…${value}` : value
}

function semanticTerms(query: string) {
  const terms = new Set(normalize(query).split(/[\s,，。！？?；;]+/).filter(Boolean))
  for (const [key, aliases] of Object.entries(semanticAliases)) {
    if (query.includes(key) || aliases.some((alias) => query.toLowerCase().includes(alias))) {
      terms.add(key)
      aliases.forEach((alias) => terms.add(alias))
    }
  }
  return [...terms]
}

function scores(corpus: string, query: string) {
  const normalizedCorpus = normalize(corpus)
  const normalizedQuery = normalize(query)
  const lexical = normalizedCorpus.includes(normalizedQuery) ? 1 : 0
  const terms = semanticTerms(query)
  const matchedTerms = terms.filter((term) => normalizedCorpus.includes(normalize(term))).length
  const semantic = terms.length > 0 ? matchedTerms / terms.length : 0
  return { lexical, semantic }
}

export function demoPublicSearch(params: {
  q: string
  mode: PublicSearchMode
  type: PublicSearchType
  kb?: string
  tag?: string
  limit: number
  offset: number
}): PublicSearchResponse {
  const candidates: Array<PublicSearchResult & { lexical: number; semantic: number }> = []
  if (params.type === "all" || params.type === "article") {
    for (const article of buildDemoPublicArticleList()) {
      const storedArticle = demoStore.articles.get(article.articleId)
      if (params.kb && storedArticle?.knowledgeBaseId !== params.kb) continue
      if (params.tag && !article.tags.some((tag) => tag.toLowerCase() === params.tag?.toLowerCase())) continue
      const detail = findDemoPublicArticle(article.shareCode)
      const content = `${article.title} ${article.excerpt} ${detail?.contentMd ?? ""}`
      const score = scores(content, params.q)
      candidates.push({
        id: `article:${article.articleId}`,
        type: "article",
        title: article.title,
        summary: article.excerpt,
        snippet: snippets(detail?.contentMd ?? article.excerpt, params.q),
        href: article.href,
        updatedAt: article.updatedAt,
        score: 0,
        semanticScore: score.semantic,
        matchReason: "",
        articleId: article.articleId,
        knowledgeBaseId: null,
        pageKey: null,
        kind: null,
        categoryPath: [],
        tags: article.tags,
        knowledgeBaseName: null,
        sourceCount: null,
        lexical: score.lexical,
        semantic: score.semantic,
      })
    }
  }
  if (params.type === "all" || params.type === "wiki") {
    for (const knowledgeBase of demoPublicWikiKnowledgeBases()) {
      if (params.kb && knowledgeBase.knowledgeBaseId !== params.kb) continue
      if (params.tag) continue
      const pageList = demoPublicWikiPageList({ knowledgeBaseId: knowledgeBase.knowledgeBaseId, limit: 100 })
      for (const page of pageList?.items ?? []) {
        const corpus = `${page.title} ${page.summary} ${page.aliases.join(" ")} ${page.categoryPath.join(" ")}`
        const score = scores(corpus, params.q)
        candidates.push({
          id: `wiki:${knowledgeBase.knowledgeBaseId}:${page.pageKey}`,
          type: "wiki",
          title: page.title,
          summary: page.summary,
          snippet: snippets(page.summary, params.q),
          href: page.href,
          updatedAt: page.updatedAt,
          score: 0,
          semanticScore: score.semantic,
          matchReason: "",
          knowledgeBaseId: knowledgeBase.knowledgeBaseId,
          pageKey: page.pageKey,
          kind: page.kind,
          categoryPath: page.categoryPath,
          tags: [],
          knowledgeBaseName: knowledgeBase.name,
          sourceCount: page.sourceCount,
          lexical: score.lexical,
          semantic: score.semantic,
        })
      }
    }
  }

  const matched = candidates.filter((item) => {
    if (params.mode === "fulltext" || params.mode === "lexical") return item.lexical > 0
    if (params.mode === "semantic") return item.semantic > 0
    return item.lexical > 0 || item.semantic > 0
  }).map((item) => {
    const combined = params.mode === "fulltext" || params.mode === "lexical"
      ? item.lexical
      : params.mode === "semantic"
        ? item.semantic
        : item.lexical * 0.45 + item.semantic * 0.55
    return {
      ...item,
      score: combined,
      matchReason: item.lexical > 0 && item.semantic > 0
        ? "全文与语义共同匹配"
        : item.lexical > 0 ? "全文匹配" : "语义相关",
    }
  }).sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))

  const items = matched.slice(params.offset, params.offset + params.limit).map(({ lexical: _lexical, semantic: _semantic, ...item }) => item)
  return {
    query: params.q,
    mode: params.mode,
    modeRequested: params.mode,
    modeApplied: params.mode,
    type: params.type,
    knowledgeBaseId: params.kb || null,
    tag: params.tag || null,
    items,
    total: matched.length,
    limit: params.limit,
    offset: params.offset,
    hasMore: params.offset + items.length < matched.length,
    semanticAvailable: true,
    semanticMessage: null,
    tookMs: 1,
  }
}
