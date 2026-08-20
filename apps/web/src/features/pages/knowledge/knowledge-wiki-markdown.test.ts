import { describe, expect, it } from "vitest"

import { prepareWikiMarkdown } from "./knowledge-wiki-markdown"

describe("prepareWikiMarkdown", () => {
  it("将显式 Wiki 引用转换为可跳转链接", () => {
    expect(prepareWikiMarkdown("# Mole\n\n支持 [[concept-deep-clean|深度清理]]。", "Mole")).toBe(
      "支持 [深度清理](#wiki-page=concept-deep-clean)。",
    )
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
