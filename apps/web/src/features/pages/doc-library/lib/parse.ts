"use client"

/**
 * 浏览器端把上传的文件解析为：
 * - chunks：用于文档库 agentic 关键词检索的文本片段
 * - blocks：PDF 的版面文本块（OcrBlock[]），喂给右侧 Layout Blocks 面板
 * - pageCount：页数（PDF）
 *
 * 仅支持双层 PDF（带文本层）/ docx / xlsx / csv。
 */

import type { OcrBlock } from "@/components/extend/ui/layout-blocks"

export type DocFileType = "pdf" | "docx" | "xlsx" | "csv"

export interface ParsedChunk {
    text: string
    page?: number | null
    locator?: string | null
}

export interface ParsedDocument {
    pageCount: number | null
    chunks: ParsedChunk[]
    blocks: OcrBlock[]
}

const CHUNK_TARGET_CHARS = 700

export function detectFileType(file: File): DocFileType | null {
    const name = file.name.toLowerCase()
    if (name.endsWith(".pdf")) return "pdf"
    if (name.endsWith(".docx")) return "docx"
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "xlsx"
    if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv"
    return null
}

export async function parseDocument(file: File, fileType: DocFileType): Promise<ParsedDocument> {
    switch (fileType) {
        case "pdf":
            return await parsePdf(file)
        case "docx":
            return await parseDocx(file)
        case "xlsx":
            return await parseXlsx(file)
        case "csv":
            return await parseCsv(file)
        default:
            return { pageCount: null, chunks: [], blocks: [] }
    }
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
    const chunks: ParsedChunk[] = []
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

            const pageText = pageBlocks.map((b) => b.text).join("\n").trim()
            for (const piece of splitIntoChunks(pageText)) {
                chunks.push({ text: piece, page: pageNo, locator: `p.${pageNo}` })
            }
            page.cleanup()
        }
        return { pageCount: pdf.numPages, chunks, blocks }
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
        const merged = texts.join("\n")
        const chunks = splitIntoChunks(merged).map((text) => ({ text, page: null, locator: null }))
        return { pageCount: null, chunks, blocks: [] }
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
    const chunks: ParsedChunk[] = []
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
        // 每 ~40 行成一个 chunk，定位用工作表名
        const batchSize = 40
        for (let i = 0; i < lines.length; i += batchSize) {
            const text = lines.slice(i, i + batchSize).join("\n")
            for (const piece of splitIntoChunks(text)) {
                chunks.push({ text: piece, page: null, locator: sheetName })
            }
        }
    }
    return { pageCount: null, chunks, blocks: [] }
}

// ---------- 共用 ----------

function splitIntoChunks(text: string): string[] {
    const normalized = text.replace(/\n{3,}/g, "\n\n").trim()
    if (!normalized) return []
    if (normalized.length <= CHUNK_TARGET_CHARS) return [normalized]
    const chunks: string[] = []
    const paragraphs = normalized.split(/\n+/)
    let buffer = ""
    for (const paragraph of paragraphs) {
        if (buffer && (buffer.length + paragraph.length + 1) > CHUNK_TARGET_CHARS) {
            chunks.push(buffer.trim())
            buffer = ""
        }
        if (paragraph.length > CHUNK_TARGET_CHARS) {
            // 超长段落硬切
            for (let i = 0; i < paragraph.length; i += CHUNK_TARGET_CHARS) {
                chunks.push(paragraph.slice(i, i + CHUNK_TARGET_CHARS))
            }
            continue
        }
        buffer = buffer ? `${buffer}\n${paragraph}` : paragraph
    }
    if (buffer.trim()) chunks.push(buffer.trim())
    return chunks
}
