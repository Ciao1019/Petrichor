import { describe, expect, it } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { extractPdfPages, PdfExtractError } from "./pdf-extract"

/** 1x1 透明 PNG，用来造一个没有文字层的「扫描件」页 */
const BLANK_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async function buildTextPdf(pageCount: number): Promise<Buffer> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= pageCount; i++) {
        const page = doc.addPage([595, 842])
        page.drawText(`Chapter ${i}`, { x: 60, y: 760, size: 28, font })
        page.drawText(`Body text on page ${i}.`, { x: 60, y: 700, size: 12, font })
    }
    return Buffer.from(await doc.save())
}

async function buildScannedPdf(): Promise<Buffer> {
    const doc = await PDFDocument.create()
    const png = await doc.embedPng(Buffer.from(BLANK_PNG_BASE64, "base64"))
    const page = doc.addPage([595, 842])
    page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 })
    return Buffer.from(await doc.save())
}

describe("extractPdfPages", () => {
    it("文字版 PDF 逐页抽取出 Markdown，且不需要 OCR", async () => {
        const result = extractPdfPages(await buildTextPdf(3))

        expect(result.pages).toHaveLength(3)
        expect(result.ocrPageNos).toEqual([])
        // pdf-inspector 内部是 0-indexed，对外必须统一成 1-indexed
        expect(result.pages.map((page) => page.pageNo)).toEqual([1, 2, 3])
        expect(result.pages.every((page) => !page.needsOcr)).toBe(true)
        expect(result.pages[0].markdown).toContain("Chapter 1")
        expect(result.pages[2].markdown).toContain("Body text on page 3")
    })

    it("扫描件页标记 needsOcr 并汇总到 ocrPageNos", async () => {
        const result = extractPdfPages(await buildScannedPdf())

        expect(result.pages).toHaveLength(1)
        expect(result.pages[0].needsOcr).toBe(true)
        expect(result.pages[0].markdown).toBe("")
        expect(result.ocrPageNos).toEqual([1])
    })

    it("非 PDF 字节抛出 PdfExtractError", () => {
        expect(() => extractPdfPages(Buffer.from("not a pdf at all"))).toThrow(PdfExtractError)
    })
})
