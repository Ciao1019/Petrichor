import { describe, expect, it, vi } from "vitest"

// 额外公开工程库的一篇来源，用两个知识库验证全站聚合与其余私有来源的隔离。
vi.mock("./demo-public-data", () => ({
  demoShareCodeForArticle: (articleId: string) =>
    ["demo-a-mole", "demo-a-fastfetch", "demo-a-rsc"].includes(articleId) ? `share-${articleId}` : null,
}))

import { demoPublicWikiKnowledgeBases, demoPublicWikiPage, demoPublicWikiPageList } from "./demo-wiki"

describe("公开 Wiki 演示契约", () => {
  it("全站目录聚合各知识库，保留可消歧的详情地址", () => {
    const global = demoPublicWikiPageList({})!
    const scoped = demoPublicWikiKnowledgeBases().flatMap((kb) =>
      demoPublicWikiPageList({ knowledgeBaseId: kb.knowledgeBaseId })!.items,
    )
    expect(global.knowledgeBaseName).toBe("公开 Wiki")
    expect(global.items.map((page) => page.href).sort()).toEqual(scoped.map((page) => page.href).sort())
    expect(new Set(global.items.map((page) => page.href)).size).toBe(global.total)
    expect(new Set(global.items.map((page) => page.href.split("/")[2])).size).toBeGreaterThan(1)
  })

  it("目录中的详情和邻居均能公开读取，并附带公开来源", () => {
    for (const item of demoPublicWikiPageList({})!.items) {
      const kb = item.href.split("/")[2]
      const detail = demoPublicWikiPage(item.pageKey, kb)!
      expect(detail.href).toBe(item.href)
      expect(detail.sourceArticles.length).toBeGreaterThan(0)
      expect(detail.sourceArticles.every((article) => article.href.startsWith("/p/"))).toBe(true)
      for (const link of [...detail.links, ...detail.inLinks]) {
        expect(demoPublicWikiPage(link.pageKey, kb)?.href).toBe(link.href)
      }
    }
  })

  it("内部索引、未知知识库和不存在的页面不进入公开详情", () => {
    expect(demoPublicWikiPage("index")).toBeNull()
    expect(demoPublicWikiPage("missing")).toBeNull()
    expect(demoPublicWikiPage("entity-mole", "missing")).toBeNull()
    expect(demoPublicWikiPageList({ knowledgeBaseId: "missing" })).toBeNull()
    expect(demoPublicWikiPageList({ knowledgeBaseId: "demo-kb-reading" })?.total).toBe(0)
    expect(demoPublicWikiPage("entity-mole")?.title).toBe("Mole")
  })

  it("跨库分页无重复，偏移和空结果保持一致", () => {
    const first = demoPublicWikiPageList({ offset: -1, limit: 2 })!
    const second = demoPublicWikiPageList({ offset: 2, limit: 2 })!
    expect(first.offset).toBe(0)
    expect(first.hasMore).toBe(true)
    expect(second.items.some((item) => first.items.some((previous) => previous.href === item.href))).toBe(false)
    const empty = demoPublicWikiPageList({ offset: first.total, limit: 2 })!
    expect(empty.items).toEqual([])
    expect(empty.hasMore).toBe(false)
    expect(empty.total).toBe(first.total)
    expect(demoPublicWikiPageList({ limit: 0 })?.limit).toBe(1)
  })

  it("搜索忽略大小写和首尾空格，并与类型筛选同时生效", () => {
    const result = demoPublicWikiPageList({ q: "  MOLE  ", kind: "entity" })!
    expect(result.items.map((page) => page.pageKey)).toEqual(["entity-mole"])
    expect(demoPublicWikiPageList({ q: "不存在的术语", kind: "all" })?.total).toBe(0)
  })
})
