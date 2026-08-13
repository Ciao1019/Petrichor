"use client"

/**
 * 浏览器端把上传的文件解析为：
 * - extractedText：完整正文
 * - segments：页 / 工作表边界，供服务端给分片补定位信息
 * - blocks：PDF 的版面文本块（OcrBlock[]），喂给右侧 Layout Blocks 面板
 * - pageCount：页数（PDF）
 *
 * 分块不在这里做。切分规则属于知识库配置，由 Go 侧统一执行
 * （apps/api/internal/chunker，移植自 WeKnora），这样网页上传与 API 上传
 * 切出来的分片完全一致，改了分块参数也能在服务端直接重切。
 *
 * 仅支持双层 PDF（带文本层）/ docx / xlsx / csv。
 */

import type { OcrBlock } from "@/components/extend/ui/layout-blocks"

export type DocFileType = "md" | "pdf" | "docx" | "xlsx" | "csv"
export type SupportedDocumentFileType = DocFileType | "markdown" | "xls" | "tsv"

/** 抽取正文里一段区间的归属，用来给服务端切出的分片补页码/工作表名。 */
export interface TextSegment {
    startOffset: number
    page?: number | null
    locator?: string | null
}

export interface ParsedDocument {
    pageCount: number | null
    /** 文件解析出的完整正文，分块由服务端按知识库配置执行。 */
    extractedText: string
    /** 正文里的页 / 工作表边界，服务端据此给分片补定位信息。 */
    segments: TextSegment[]
    /** PDF 的版面文本块，喂给右侧 Layout Blocks 面板。 */
    blocks: OcrBlock[]
}

/** 认为文本层稀薄到需要多模态兜底的页面字符数阈值。 */
const SCANNED_PAGE_TEXT_THRESHOLD = 24

/**
 * 挑出需要交给多模态识别的页码（1-indexed）。
 *
 * 上面的 parsePdf 已经把每页文本用换页符拼进 extractedText，所以这里直接按
 * 换页符还原页边界：文本层几乎为空的页就是扫描页。「按扫描件解析」时整份都要识别。
 *
 * 服务端没有 PDF 渲染能力，页面图片只能由浏览器栅格化，所以这个判断必须在前端做。
 */
export function pickPagesNeedingVision(parsed: ParsedDocument, engine: "auto" | "local" | "scan"): number[] {
    const total = parsed.pageCount ?? 0
    if (total <= 0) return []
    if (engine === "scan") return Array.from({ length: total }, (_, index) => index + 1)
    const pageTexts = parsed.extractedText.split("\f")
    const pages: number[] = []
    for (let index = 0; index < total; index += 1) {
        const text = (pageTexts[index] ?? "").trim()
        if (Array.from(text).length < SCANNED_PAGE_TEXT_THRESHOLD) pages.push(index + 1)
    }
    return pages
}

export function detectFileType(file: File): DocFileType | null {
    const name = file.name.toLowerCase()
    if (name.endsWith(".pdf")) return "pdf"
    if (name.endsWith(".md") || name.endsWith(".markdown")) return "md"
    if (name.endsWith(".docx")) return "docx"
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "xlsx"
    if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv"
    return null
}

export async function parseDocument(file: File, fileType: SupportedDocumentFileType): Promise<ParsedDocument> {
    switch (normalizeFileType(fileType)) {
        case "md":
            return await parseMarkdown(file)
        case "pdf":
            return await parsePdf(file)
        case "docx":
            return await parseDocx(file)
        case "xlsx":
            return await parseXlsx(file)
        case "csv":
            return await parseCsv(file)
        default:
            return { pageCount: null, extractedText: "", segments: [], blocks: [] }
    }
}

function normalizeFileType(fileType: SupportedDocumentFileType): DocFileType {
    if (fileType === "markdown") return "md"
    if (fileType === "xls") return "xlsx"
    if (fileType === "tsv") return "csv"
    return fileType
}

// ---------- PDF ----------

interface RawTextItem {
    str: string
    left: number
    top: number
    right: number
    bottom: number
    fontHeight: number
}

async function parsePdf(file: File): Promise<ParsedDocument> {
    const pdfjs = await import("pdfjs-dist")
    const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString()

    const data = await file.arrayBuffer()
    const loadingTask = pdfjs.getDocument({ data })
    const pdf = await loadingTask.promise
    const blocks: OcrBlock[] = []
    const pageTexts: string[] = []
    try {
        const total = pdf.numPages
        for (let pageNo = 1; pageNo <= total; pageNo += 1) {
            const page = await pdf.getPage(pageNo)
            const viewport = page.getViewport({ scale: 1 })
            const pageWidth = viewport.width
            const pageHeight = viewport.height
            const content = await page.getTextContent()
            const items = extractItems(content.items as unknown[], pageHeight)
            const lines = groupIntoLines(items)
            const pageBlocks = groupIntoBlocks(lines, pageNo, pageWidth, pageHeight)
            blocks.push(...pageBlocks)

            pageTexts.push(pageBlocks.map((b) => b.text).join("\n").trim())
            page.cleanup()
        }
        const extractedText = pageTexts.join("\n\f\n")
        const pageStarts: number[] = []
        let cursor = 0
        for (const pageText of pageTexts) {
            pageStarts.push(cursor)
            cursor += Array.from(pageText).length + 3
        }
        const segments: TextSegment[] = pageStarts.map((startOffset, index) => ({
            startOffset,
            page: index + 1,
            locator: `p.${index + 1}`,
        }))
        return { pageCount: pdf.numPages, extractedText, segments, blocks }
    } finally {
        await loadingTask.destroy()
    }
}

function extractItems(rawItems: unknown[], pageHeight: number): RawTextItem[] {
    const items: RawTextItem[] = []
    for (const raw of rawItems) {
        const item = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown }
        if (typeof item.str !== "string" || !item.str.trim()) continue
        const transform = Array.isArray(item.transform) ? (item.transform as number[]) : null
        if (!transform || transform.length < 6) continue
        const x = transform[4]
        const yBottom = transform[5]
        const fontHeight = Math.abs(transform[3]) || Math.hypot(transform[2] ?? 0, transform[3] ?? 0) || 10
        const width = typeof item.width === "number" ? item.width : item.str.length * fontHeight * 0.5
        const height = typeof item.height === "number" && item.height > 0 ? item.height : fontHeight
        const top = pageHeight - yBottom - height
        items.push({
            str: item.str,
            left: x,
            right: x + width,
            top,
            bottom: top + height,
            fontHeight,
        })
    }
    return items
}

function groupIntoLines(items: RawTextItem[]): RawTextItem[] {
    const sorted = [...items].sort((a, b) => (a.top - b.top) || (a.left - b.left))
    const lines: RawTextItem[] = []
    let current: RawTextItem | null = null
    for (const item of sorted) {
        if (current && Math.abs(item.top - current.top) <= Math.max(3, current.fontHeight * 0.6)) {
            // 同一行：合并
            const gap = item.left - current.right
            current.str += (gap > current.fontHeight * 0.3 ? " " : "") + item.str
            current.right = Math.max(current.right, item.right)
            current.left = Math.min(current.left, item.left)
            current.top = Math.min(current.top, item.top)
            current.bottom = Math.max(current.bottom, item.bottom)
            current.fontHeight = Math.max(current.fontHeight, item.fontHeight)
        } else {
            if (current) lines.push(current)
            current = { ...item }
        }
    }
    if (current) lines.push(current)
    return lines
}

function groupIntoBlocks(lines: RawTextItem[], page: number, pageWidth: number, pageHeight: number): OcrBlock[] {
    if (lines.length === 0) return []
    const heights = lines.map((l) => l.fontHeight).sort((a, b) => a - b)
    const medianHeight = heights[Math.floor(heights.length / 2)] || 10

    const blocks: OcrBlock[] = []
    let group: RawTextItem[] = []
    const flush = () => {
        if (group.length === 0) return
        const left = Math.min(...group.map((l) => l.left))
        const right = Math.max(...group.map((l) => l.right))
        const top = Math.min(...group.map((l) => l.top))
        const bottom = Math.max(...group.map((l) => l.bottom))
        const maxFont = Math.max(...group.map((l) => l.fontHeight))
        const text = group.map((l) => l.str).join("\n").trim()
        if (text) {
            const isHeading = group.length <= 2 && maxFont >= medianHeight * 1.25
            blocks.push({
                id: `p${page}-b${blocks.length}`,
                type: isHeading ? "heading" : "paragraph",
                text,
                page,
                pageWidth,
                pageHeight,
                confidence: 1,
                boundingBox: { left, top, right, bottom },
            })
        }
        group = []
    }

    let prev: RawTextItem | null = null
    for (const line of lines) {
        if (prev) {
            const verticalGap = line.top - prev.bottom
            const fontJump = Math.abs(line.fontHeight - prev.fontHeight) > medianHeight * 0.4
            if (verticalGap > prev.fontHeight * 1.1 || fontJump) {
                flush()
            }
        }
        group.push(line)
        prev = line
    }
    flush()
    return blocks
}

// ---------- DOCX ----------

async function parseDocx(file: File): Promise<ParsedDocument> {
    const { renderAsync } = await import("docx-preview")
    const container = document.createElement("div")
    container.style.position = "fixed"
    container.style.left = "-10000px"
    container.style.top = "0"
    document.body.appendChild(container)
    try {
        await renderAsync(await file.arrayBuffer(), container, undefined, {
            inWrapper: true,
            breakPages: true,
        })
        const paragraphs = Array.from(container.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, td, th"))
        const texts = paragraphs
            .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        const extractedText = texts.join("\n")
        return { pageCount: null, extractedText, segments: [], blocks: [] }
    } finally {
        container.remove()
    }
}

// ---------- XLSX / CSV ----------

async function parseXlsx(file: File): Promise<ParsedDocument> {
    const XLSX = await import("xlsx")
    const data = await file.arrayBuffer()
    const workbook = XLSX.read(data, { type: "array" })
    return workbookToParsed(XLSX, workbook)
}

async function parseCsv(file: File): Promise<ParsedDocument> {
    const XLSX = await import("xlsx")
    const text = await file.text()
    const workbook = XLSX.read(text, { type: "string" })
    return workbookToParsed(XLSX, workbook)
}

function workbookToParsed(
    XLSX: typeof import("xlsx"),
    workbook: import("xlsx").WorkBook,
): ParsedDocument {
    const sheets: Array<{ name: string; text: string }> = []
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        if (!sheet) continue
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" })
        const header = Array.isArray(rows[0]) ? (rows[0] as unknown[]).map((c) => String(c ?? "").trim()) : []
        const lines: string[] = []
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i] as unknown[]
            if (!Array.isArray(row)) continue
            const cells = row.map((cell, index) => {
                const value = String(cell ?? "").replace(/\s+/g, " ").trim()
                if (!value) return ""
                const key = i > 0 && header[index] ? `${header[index]}: ` : ""
                return `${key}${value}`
            }).filter(Boolean)
            if (cells.length > 0) lines.push(cells.join(" | "))
        }
        sheets.push({ name: sheetName, text: `# ${sheetName}\n\n${lines.join("\n")}` })
    }
    const extractedText = sheets.map((sheet) => sheet.text).join("\n\f\n")
    const starts: number[] = []
    let cursor = 0
    for (const sheet of sheets) {
        starts.push(cursor)
        cursor += Array.from(sheet.text).length + 3
    }
    const segments: TextSegment[] = starts.map((startOffset, index) => ({
        startOffset,
        page: null,
        locator: sheets[index]?.name ?? null,
    }))
    return { pageCount: null, extractedText, segments, blocks: [] }
}

// ---------- 共用 ----------

async function parseMarkdown(file: File): Promise<ParsedDocument> {
    const extractedText = (await file.text()).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    return { pageCount: null, extractedText, segments: [{ startOffset: 0, page: null, locator: "Markdown" }], blocks: [] }
}
