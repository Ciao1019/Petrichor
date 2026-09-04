import { describe, expect, it } from "vitest"

import {
  buildDemoPublicArticleList,
  findDemoPublicArticle,
  searchDemoPublicArticles,
} from "./demo-public-data"
import {
  demoPublicWikiGraph,
  demoPublicWikiKnowledgeBases,
  demoPublicWikiPage,
  demoWikiGraph,
  demoWikiPageDetail,
  demoWikiPages,
} from "./demo-wiki"

describe("Vercel 静态演示数据", () => {
  it("提供两篇完整、可搜索且互相关联的工具文章", () => {
    const articles = buildDemoPublicArticleList()
    const detail = findDemoPublicArticle("mole-macos-guide")

    expect(articles).toHaveLength(2)
    expect(articles[0]?.isPinned).toBe(true)
    expect(detail?.title).toContain("小鼹鼠 Mole")
    expect(detail?.contentMd).toContain("mo clean --dry-run")
    expect(detail?.contentMd.length).toBeGreaterThan(9_000)
    expect(findDemoPublicArticle("fastfetch-guide")?.contentMd.length).toBeGreaterThan(12_000)
    expect(articles.some((article) => article.articleId === "demo-a-fastfetch")).toBe(true)
    expect(searchDemoPublicArticles("JSONC").items[0]?.href).toBe("/p/fastfetch-guide")
  })

  it("提供后台知识空间详情与图谱", () => {
    const knowledgeBaseId = "demo-kb-product"
    const pages = demoWikiPages(knowledgeBaseId)
    const detail = demoWikiPageDetail(knowledgeBaseId, "concept-safe-cleanup")
    const graph = demoWikiGraph(knowledgeBaseId)
    const publicPage = demoPublicWikiPage("concept-safe-cleanup")

    expect(pages.some((page) => page.kind === "index")).toBe(true)
    expect(pages.some((page) => page.kind === "source")).toBe(true)
    expect(detail?.links.some((link) => link.toPageKey === "concept-mole-whitelist")).toBe(true)
    expect(detail?.sourceRefs[0]?.articleId).toBe("demo-a-mole")
    expect(graph.stats.pageCount).toBe(pages.length)
    expect(graph.stats.linkCount).toBeGreaterThan(0)
    expect(publicPage?.sourceArticles[0]?.href).toBe("/p/mole-macos-guide")
  })

  it("公开 Wiki 只投影两篇已公开文章的安全知识页", () => {
    const knowledgeBases = demoPublicWikiKnowledgeBases()
    const graph = demoPublicWikiGraph("demo-kb-product")

    expect(knowledgeBases.map((item) => item.knowledgeBaseId)).toEqual(["demo-kb-product"])
    expect(demoPublicWikiPage("source-1", "demo-kb-engineering")).toBeNull()
    expect(graph?.nodes.length).toBeGreaterThan(0)
    expect(graph?.links.every((link) =>
      graph.nodes.some((node) => node.pageKey === link.fromPageKey)
      && graph.nodes.some((node) => node.pageKey === link.toPageKey))).toBe(true)
  })
})
