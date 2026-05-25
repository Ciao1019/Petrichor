import type { ArticleDetailResponse } from "@/lib/api"

export const MARKDOWN_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024
export const DOCX_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024

export type ArticleEditorSnapshot = {
  title: string
  contentMd: string
  contentJson: string
  contentMetaJson: string
  tags: string[]
}

export function normalizeArticleTags(raw: string[]): string[] {
  const next: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const tag = item.trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    next.push(tag)
  }
  return next
}

export function buildSnapshotFromArticleDetail(article: ArticleDetailResponse): ArticleEditorSnapshot {
  return {
    title: article.title || "",
    contentMd: article.contentMd || "",
    contentJson: article.contentJson || "",
    contentMetaJson: article.contentMetaJson || "",
    tags: normalizeArticleTags(article.tags || []),
  }
}

export function buildArticleSnapshotKey(snapshot: ArticleEditorSnapshot): string {
  return JSON.stringify({
    title: snapshot.title,
    contentMd: snapshot.contentMd,
    contentJson: snapshot.contentJson,
    contentMetaJson: snapshot.contentMetaJson,
    tags: normalizeArticleTags(snapshot.tags),
  })
}

export function isMarkdownFileName(fileName: string): boolean {
  return /\.(md|markdown)$/i.test(fileName.trim())
}

export function isDocxFileName(fileName: string): boolean {
  return /\.docx$/i.test(fileName.trim())
}

export function validateMarkdownImportFile(file: { name: string; size: number }): string | null {
  if (!isMarkdownFileName(file.name)) {
    return "请选择 .md 或 .markdown 格式的 Markdown 文件"
  }
  if (file.size > MARKDOWN_IMPORT_MAX_FILE_BYTES) {
    return "Markdown 文件过大，单个文件不能超过 2 MB"
  }
  if (file.size === 0) {
    return "Markdown 文件为空，无法导入"
  }
  return null
}

export function validateDocxImportFile(file: { name: string; size: number }): string | null {
  if (!isDocxFileName(file.name)) {
    return "请选择 .docx 格式的 Word 文档"
  }
  if (file.size > DOCX_IMPORT_MAX_FILE_BYTES) {
    return "DOCX 文件过大，单个文件不能超过 25 MB"
  }
  if (file.size === 0) {
    return "DOCX 文件为空，无法导入"
  }
  return null
}

export function validateMarkdownImportText(markdown: string): string | null {
  if (!markdown.trim()) {
    return "Markdown 文件没有可导入的正文内容"
  }
  return null
}

export function removeMarkdownFileExtension(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() || fileName
  return name.replace(/\.(md|markdown)$/i, "").trim()
}

export function removeArticleImportFileExtension(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() || fileName
  return name.replace(/\.(md|markdown|docx)$/i, "").trim()
}

function cleanMarkdownHeadingText(value: string): string {
  return value
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function findFirstLevelOneHeading(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  let fence: { marker: "`" | "~"; length: number } | null = null
  let previousTextLine = ""

  for (const line of lines) {
    const trimmedRight = line.replace(/\s+$/, "")
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(trimmedRight)
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length,
      }
      previousTextLine = ""
      continue
    }

    const atxMatch = /^ {0,3}#(?!#)(?:\s+|$)(.*)$/.exec(trimmedRight)
    if (atxMatch) {
      const title = cleanMarkdownHeadingText(atxMatch[1])
      if (title) return title
    }

    if (/^ {0,3}=+\s*$/.test(trimmedRight) && previousTextLine) {
      const title = cleanMarkdownHeadingText(previousTextLine)
      if (title) return title
    }

    const plainTextLine = trimmedRight.trim()
    previousTextLine =
      plainTextLine &&
      !/^ {0,3}(#{1,6}(?:\s+|$)|>|[-+*]\s+|\d+\.\s+)/.test(trimmedRight)
        ? plainTextLine
        : ""
  }

  return ""
}

export function resolveMarkdownImportTitle(markdown: string, fileName: string): string {
  return (
    findFirstLevelOneHeading(markdown) ||
    removeArticleImportFileExtension(fileName) ||
    "未命名文章"
  )
}

export function buildMarkdownExportFileName(title: string): string {
  const safeBaseName = title
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim()
    .replace(/\.(md|markdown)$/i, "")
    .trim()

  return `${safeBaseName || "未命名文章"}.md`
}
