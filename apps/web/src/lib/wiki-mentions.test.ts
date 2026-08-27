import { describe, expect, it } from "vitest"

import { annotateNormalQaWikiMentions, type WikiMentionTarget } from "./wiki-mentions"

const targets: WikiMentionTarget[] = [
  {
    pageKey: "concept-deep-clean",
    title: "深度清理",
    aliases: [],
    kind: "concept",
    citationIndex: null,
  },
  {
    pageKey: "entity-homebrew",
    title: "Homebrew",
    aliases: ["brew"],
    kind: "entity",
    citationIndex: null,
  },
]

describe("annotateNormalQaWikiMentions", () => {
  it("给 Markdown 表格单元格里的 Wiki 词补内链标记", () => {
    const markdown = [
      "| 功能 | 说明 |",
      "| --- | --- |",
      "| **深度清理** | 清理缓存 |",
      "",
      "推荐用 Homebrew 安装。",
    ].join("\n")

    expect(annotateNormalQaWikiMentions(markdown, targets)).toContain(
      "| **[[concept-deep-clean|深度清理]]** | 清理缓存 |",
    )
  })

  it("不改代码和已有 Markdown 链接，且同一页面只标首次提及", () => {
    const markdown = "`Homebrew` [Homebrew](https://brew.sh)\n\n| 工具 | 说明 |\n| --- | --- |\n| Homebrew | brew 包管理器 |"
    const annotated = annotateNormalQaWikiMentions(markdown, targets)

    expect(annotated).toContain("`Homebrew` [Homebrew](https://brew.sh)")
    expect(annotated.match(/\[\[entity-homebrew\|Homebrew]]/g)).toHaveLength(1)
  })
})
