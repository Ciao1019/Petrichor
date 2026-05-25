import { describe, expect, it } from "vitest"

import {
  DOCX_IMPORT_MAX_FILE_BYTES,
  buildMarkdownExportFileName,
  isDocxFileName,
  isMarkdownFileName,
  MARKDOWN_IMPORT_MAX_FILE_BYTES,
  removeArticleImportFileExtension,
  removeMarkdownFileExtension,
  resolveMarkdownImportTitle,
  validateDocxImportFile,
  validateMarkdownImportFile,
  validateMarkdownImportText,
} from "./article-editor-utils"

describe("article editor Markdown import/export utilities", () => {
  it("识别 Markdown 文件扩展名", () => {
    expect(isMarkdownFileName("note.md")).toBe(true)
    expect(isMarkdownFileName("NOTE.MARKDOWN")).toBe(true)
    expect(isMarkdownFileName("note.txt")).toBe(false)
  })

  it("识别 DOCX 文件扩展名", () => {
    expect(isDocxFileName("note.docx")).toBe(true)
    expect(isDocxFileName("NOTE.DOCX")).toBe(true)
    expect(isDocxFileName("note.doc")).toBe(false)
  })

  it("校验 Markdown 导入文件", () => {
    expect(validateMarkdownImportFile({ name: "note.md", size: 12 })).toBeNull()
    expect(validateMarkdownImportFile({ name: "note.txt", size: 12 })).toBe(
      "请选择 .md 或 .markdown 格式的 Markdown 文件"
    )
    expect(validateMarkdownImportFile({ name: "note.md", size: 0 })).toBe(
      "Markdown 文件为空，无法导入"
    )
    expect(
      validateMarkdownImportFile({
        name: "note.markdown",
        size: MARKDOWN_IMPORT_MAX_FILE_BYTES + 1,
      })
    ).toBe("Markdown 文件过大，单个文件不能超过 2 MB")
  })

  it("校验 DOCX 导入文件", () => {
    expect(validateDocxImportFile({ name: "note.docx", size: 12 })).toBeNull()
    expect(validateDocxImportFile({ name: "note.doc", size: 12 })).toBe(
      "请选择 .docx 格式的 Word 文档"
    )
    expect(validateDocxImportFile({ name: "note.docx", size: 0 })).toBe(
      "DOCX 文件为空，无法导入"
    )
    expect(
      validateDocxImportFile({
        name: "note.docx",
        size: DOCX_IMPORT_MAX_FILE_BYTES + 1,
      })
    ).toBe("DOCX 文件过大，单个文件不能超过 25 MB")
  })

  it("校验 Markdown 导入正文", () => {
    expect(validateMarkdownImportText("# 标题\n\n正文")).toBeNull()
    expect(validateMarkdownImportText("   \n\t")).toBe("Markdown 文件没有可导入的正文内容")
  })

  it("移除 Markdown 扩展名作为文件名标题兜底", () => {
    expect(removeMarkdownFileExtension("知识库导入.markdown")).toBe("知识库导入")
    expect(removeMarkdownFileExtension("/tmp/知识库.md")).toBe("知识库")
  })

  it("移除文章导入文件扩展名作为标题兜底", () => {
    expect(removeArticleImportFileExtension("知识库导入.docx")).toBe("知识库导入")
    expect(removeArticleImportFileExtension("/tmp/知识库.markdown")).toBe("知识库")
  })

  it("优先使用 Markdown 中第一个一级标题", () => {
    expect(
      resolveMarkdownImportTitle(
        ["## 二级标题", "", "# 一级标题 **加粗**", "", "正文"].join("\n"),
        "fallback.md"
      )
    ).toBe("一级标题 加粗")
  })

  it("忽略代码块里的伪一级标题", () => {
    expect(
      resolveMarkdownImportTitle(
        ["```markdown", "# 代码标题", "```", "", "# 正文标题"].join("\n"),
        "fallback.md"
      )
    ).toBe("正文标题")
  })

  it("没有一级标题时使用去扩展名后的文件名", () => {
    expect(resolveMarkdownImportTitle("正文内容", "本地笔记.md")).toBe("本地笔记")
    expect(resolveMarkdownImportTitle("正文内容", "Word 笔记.docx")).toBe("Word 笔记")
  })

  it("导出文件名使用文章标题并清理非法字符", () => {
    expect(buildMarkdownExportFileName('  知识库:导入/导出?.md  ')).toBe("知识库 导入 导出.md")
    expect(buildMarkdownExportFileName("   ")).toBe("未命名文章.md")
  })
})
