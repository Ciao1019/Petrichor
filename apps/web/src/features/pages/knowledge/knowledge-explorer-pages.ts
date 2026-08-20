import type { KnowledgeBaseWikiPageResponse } from "@/lib/api"

export type KnowledgeExplorerSection = "knowledge" | "summaries"

/** 日志页属于内部维护数据，不在面向用户的知识空间导航中展示。 */
export function resolveKnowledgeExplorerSection(
  page: KnowledgeBaseWikiPageResponse,
): KnowledgeExplorerSection | null {
  if (page.archivedAt || page.kind === "log") return null
  return page.kind === "source" ? "summaries" : "knowledge"
}

export function filterKnowledgeExplorerPages(
  pages: KnowledgeBaseWikiPageResponse[],
  section: KnowledgeExplorerSection,
): KnowledgeBaseWikiPageResponse[] {
  return pages.filter((page) => resolveKnowledgeExplorerSection(page) === section)
}

export function matchesKnowledgeExplorerQuery(
  page: KnowledgeBaseWikiPageResponse,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return [
    page.title,
    page.summary ?? "",
    ...page.aliases,
    ...page.categoryPath,
  ].join(" ").toLowerCase().includes(normalizedQuery)
}

/** 知识区优先打开总索引；摘要区打开第一篇文章摘要。 */
export function resolveDefaultKnowledgeExplorerPage(
  pages: KnowledgeBaseWikiPageResponse[],
  section: KnowledgeExplorerSection,
): KnowledgeBaseWikiPageResponse | undefined {
  const sectionPages = filterKnowledgeExplorerPages(pages, section)
  if (section === "knowledge") {
    return sectionPages.find((page) => page.kind === "index" || page.pageKey === "index")
      ?? sectionPages[0]
  }
  return sectionPages[0]
}
