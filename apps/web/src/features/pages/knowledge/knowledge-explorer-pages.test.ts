import { describe, expect, it } from "vitest"

import type { KnowledgeBaseWikiPageKind, KnowledgeBaseWikiPageResponse } from "@/lib/api"
import {
  filterKnowledgeExplorerPages,
  matchesKnowledgeExplorerQuery,
  resolveDefaultKnowledgeExplorerPage,
} from "@/features/pages/knowledge/knowledge-explorer-pages"

function page(
  pageKey: string,
  kind: KnowledgeBaseWikiPageKind,
  overrides: Partial<KnowledgeBaseWikiPageResponse> = {},
): KnowledgeBaseWikiPageResponse {
  return {
    id: pageKey,
    knowledgeBaseId: "1",
    pageKey,
    title: pageKey,
    kind,
    contentMd: "",
    frontmatter: {},
    categoryPath: [],
    aliases: [],
    contentHash: pageKey,
    version: 1,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

describe("knowledge explorer pages", () => {
  const pages = [
    page("entity-mole", "entity"),
    page("source-3", "source", { title: "小鼹鼠", summary: "macOS 清理工具" }),
    page("index", "index", { title: "我的文档 Wiki 索引" }),
    page("build-log", "log"),
    page("old-concept", "concept", { archivedAt: "2026-08-20T00:00:00.000Z" }),
  ]

  it("知识区包含 Wiki 索引，摘要区包含源文章页", () => {
    expect(filterKnowledgeExplorerPages(pages, "knowledge").map((item) => item.pageKey))
      .toEqual(["entity-mole", "index"])
    expect(filterKnowledgeExplorerPages(pages, "summaries").map((item) => item.pageKey))
      .toEqual(["source-3"])
  })

  it("进入知识区时优先选择 Wiki 索引", () => {
    expect(resolveDefaultKnowledgeExplorerPage(pages, "knowledge")?.pageKey).toBe("index")
  })

  it("文章标题和摘要都可以被搜索", () => {
    const sourcePage = pages[1]
    expect(matchesKnowledgeExplorerQuery(sourcePage, "小鼹鼠")).toBe(true)
    expect(matchesKnowledgeExplorerQuery(sourcePage, "macOS")).toBe(true)
    expect(matchesKnowledgeExplorerQuery(sourcePage, "不存在")).toBe(false)
  })
})
