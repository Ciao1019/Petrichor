import type { ArticleDetailResponse } from "@/lib/api"

export const MARKDOWN_IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024
export const DOCX_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const DOCUMENT_IMPORT_MAX_FILE_BYTES = 100 * 1024 * 1024

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

export function isPdfFileName(fileName: string): boolean {
  return /\.pdf$/i.test(fileName.trim())
}

/** 扩展名同时作为来源类型；选择器、校验与标题清理共用这份白名单。 */
export const DOCUMENT_IMPORT_EXTENSIONS = [
  "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
  "xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "csv", "pdf",
  "md", "markdown",
] as const

export type DocumentImportKind = (typeof DOCUMENT_IMPORT_EXTENSIONS)[number]
export const DOCUMENT_IMPORT_ACCEPT = DOCUMENT_IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join(",")
export const DOCUMENT_IMPORT_FORMAT_DESCRIPTION = DOCUMENT_IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join("、")
export const DOCUMENT_IMPORT_MAX_PAGES = 500
export const DOCUMENT_IMPORT_DESCRIPTION =
  `支持 ${DOCUMENT_IMPORT_FORMAT_DESCRIPTION}；单个文件不超过 100 MB，PDF 不超过 ${DOCUMENT_IMPORT_MAX_PAGES} 页。上传提交后由 Go 服务端完成解析、栅格化、OCR 和生成文章，可关闭页面；页数限制由服务端校验。`

export function resolveDocumentImportKind(fileName: string): DocumentImportKind | null {
  const name = fileName.trim().split(/[\\/]/).pop() ?? ""
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()
  return DOCUMENT_IMPORT_EXTENSIONS.find((kind) => kind === extension) ?? null
}

/** 校验「文档导入」入口；编辑器单独导入 Markdown / DOCX 的限制保持不变。 */
export function validateDocumentImportFile(file: { name: string; size: number }): string | null {
  if (!resolveDocumentImportKind(file.name)) {
    return `请选择支持的文档格式：${DOCUMENT_IMPORT_FORMAT_DESCRIPTION}`
  }
  if (file.size > DOCUMENT_IMPORT_MAX_FILE_BYTES) {
    return "文档过大，单个文件不能超过 100 MB"
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    return "文档大小无效，无法导入"
  }
  if (file.size === 0) {
    return "文档为空，无法导入"
  }
  return null
}

export function removeDocumentImportFileExtension(fileName: string): string {
  const name = (fileName.split(/[\\/]/).pop() || fileName).trim()
  const kind = resolveDocumentImportKind(name)
  return (kind ? name.slice(0, -(kind.length + 1)) : name).trim()
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

/** 批量导入一次允许选择的最大文件数量 */
export const BATCH_IMPORT_MAX_FILES = 50

export interface ImportFileIdentity {
  name: string
  size: number
  lastModified?: number
}

/** 用文件名 + 大小 + 修改时间组合出去重 key，避免同一文件被重复加入批量列表 */
export function buildImportFileKey(file: ImportFileIdentity): string {
  return `${file.name}::${file.size}::${file.lastModified ?? 0}`
}

export interface DedupeImportFilesResult<T> {
  /** 去重后追加得到的完整列表（保留原有顺序，新文件追加在末尾） */
  merged: T[]
  /** 实际新增的文件 */
  added: T[]
  /** 因与已有文件重复而被忽略的数量 */
  duplicateCount: number
}

/** 把新选择的文件合并进已有列表，按 {@link buildImportFileKey} 去重 */
export function dedupeImportFiles<T extends ImportFileIdentity>(
  existing: T[],
  incoming: T[]
): DedupeImportFilesResult<T> {
  const seen = new Set(existing.map(buildImportFileKey))
  const added: T[] = []
  let duplicateCount = 0
  for (const file of incoming) {
    const key = buildImportFileKey(file)
    if (seen.has(key)) {
      duplicateCount += 1
      continue
    }
    seen.add(key)
    added.push(file)
  }
  return { merged: [...existing, ...added], added, duplicateCount }
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
    const fenceToken = fenceMatch?.[1]
    if (fence) {
      if (
        fenceToken &&
        fenceToken[0] === fence.marker &&
        fenceToken.length >= fence.length
      ) {
        fence = null
      }
      continue
    }
    if (fenceToken) {
      fence = {
        marker: fenceToken[0] as "`" | "~",
        length: fenceToken.length,
      }
      previousTextLine = ""
      continue
    }

    const atxMatch = /^ {0,3}#(?!#)(?:\s+|$)(.*)$/.exec(trimmedRight)
    if (atxMatch) {
      const title = cleanMarkdownHeadingText(atxMatch[1] ?? "")
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
    // 文件名必须剔除 Windows 保留字符及 ASCII 控制字符。
    // eslint-disable-next-line no-control-regex -- 有意匹配 U+0000–U+001F
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim()
    .replace(/\.(md|markdown)$/i, "")
    .trim()

  return `${safeBaseName || "未命名文章"}.md`
}
