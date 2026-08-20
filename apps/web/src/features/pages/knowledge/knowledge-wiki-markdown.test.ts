import { describe, expect, it } from "vitest"

import { prepareWikiMarkdown } from "./knowledge-wiki-markdown"

describe("prepareWikiMarkdown", () => {
  it("将显式 Wiki 引用转换为可跳转链接", () => {
    expect(prepareWikiMarkdown("# Mole\n\n支持 [[concept-deep-clean|深度清理]]。", "Mole")).toBe(
      "支持 [深度清理](#wiki-page=concept-deep-clean)。",
    )
  })

  it("没写别名时用 pageKey 反查到的标题当链接文案", () => {
    expect(prepareWikiMarkdown(
      "- [[source-9]] Mac 应用损坏修复指南：分场景解决方案。",
      "索引",
      [],
      (pageKey) => (pageKey === "source-9" ? "Mac 应用损坏修复指南" : undefined),
    )).toBe("- [Mac 应用损坏修复指南](#wiki-page=source-9)：分场景解决方案。")
  })

  it("没有 resolver 时退回相关知识里带的标题", () => {
    expect(prepareWikiMarkdown(
      "- [[source-7]] 终端代理：配置 HTTP 代理。",
      "索引",
      [{ pageKey: "source-7", title: "终端代理" }],
    )).toBe("- [终端代理](#wiki-page=source-7)：配置 HTTP 代理。")
  })

  it("标题查不到时保留 pageKey 原文", () => {
    expect(prepareWikiMarkdown("见 [[source-404]] 页。", "索引")).toBe(
      "见 [source-404](#wiki-page=source-404) 页。",
    )
  })

  it("别名与 pageKey 相同时按未命名处理，仍反查标题", () => {
    expect(prepareWikiMarkdown(
      "- [[entity-mole|entity-mole]] 属于 [[concept-clean|concept-clean]]",
      "源文档",
      [],
      (pageKey) => (pageKey === "entity-mole" ? "Mole" : "深度清理"),
    )).toBe("- [Mole](#wiki-page=entity-mole) 属于 [深度清理](#wiki-page=concept-clean)")
  })

  it("为相关知识的首次裸文本提及补链接", () => {
    expect(prepareWikiMarkdown(
      "Mole 支持深度清理，深度清理完成后会输出结果。",
      "Mole",
      [{ pageKey: "concept-deep-clean", title: "深度清理" }],
    )).toBe("Mole 支持[深度清理](#wiki-page=concept-deep-clean)，深度清理完成后会输出结果。")
  })

  it("不修改代码和已有 Markdown 链接中的同名内容", () => {
    expect(prepareWikiMarkdown(
      "`深度清理` [深度清理](https://example.com)\n\n正文中的深度清理。",
      "Mole",
      [{ pageKey: "concept-deep-clean", title: "深度清理" }],
    )).toBe(
      "`深度清理` [深度清理](https://example.com)\n\n正文中的[深度清理](#wiki-page=concept-deep-clean)。",
    )
  })
})
