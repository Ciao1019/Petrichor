import { extractPagesMarkdown } from "@firecrawl/pdf-inspector"

/**
 * 基于 @firecrawl/pdf-inspector 的本地 PDF 逐页抽取。
 *
 * 双层 PDF（带文字层）直接在本地还原成 Markdown，零模型调用；
 * 只有扫描件 / 纯图片页会被标记为 needsOcr，交给上层走多模态兜底。
 *
 * 索引口径注意：pdf-inspector 里 `pages[].page` 是 0-indexed，
 * 而顶层 `pagesNeedingOcr` 是 1-indexed（`classifyPdf` 的又是 0-indexed）。
 * 这里统一只读逐页的 `needsOcr`，对外一律输出 1-indexed 的 pageNo，避免踩混。
 */

export interface ExtractedPdfPage {
    /** 1-indexed 页码，与导入任务页表口径一致 */
    pageNo: number
    /** 本地抽取出的 Markdown；needsOcr 为 true 时通常为空 */
    markdown: string
    /** 该页文字不可信（扫描件 / 图片页 / 字体编码异常），需要走多模态识别 */
    needsOcr: boolean
    /** 机器可读的 OCR 原因，pdf-inspector 未给出时为 null */
    ocrReason: string | null
}

export interface ExtractedPdf {
    pages: ExtractedPdfPage[]
    /** 需要 OCR 的 1-indexed 页码，升序 */
    ocrPageNos: number[]
    /** 检测到表格或多栏排版，供前端提示「复杂排版」 */
    isComplex: boolean
}

/** PDF 解析失败（文件损坏 / 加密 / 非 PDF）时抛出，由 handler 转成 400。 */
export class PdfExtractError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "PdfExtractError"
    }
}

export function extractPdfPages(data: Buffer): ExtractedPdf {
    let result: ReturnType<typeof extractPagesMarkdown>
    try {
        result = extractPagesMarkdown(data)
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new PdfExtractError(`PDF 解析失败，请确认文件未加密且未损坏：${detail}`)
    }

    const pages: ExtractedPdfPage[] = result.pages
        .map((page) => ({
            pageNo: page.page + 1,
            markdown: (page.markdown ?? "").trim(),
            needsOcr: page.needsOcr,
            ocrReason: page.ocrReason ?? null,
        }))
        .sort((a, b) => a.pageNo - b.pageNo)

    if (pages.length === 0) {
        throw new PdfExtractError("未能从该 PDF 中解析出任何页面")
    }

    return {
        pages,
        ocrPageNos: pages.filter((page) => page.needsOcr).map((page) => page.pageNo),
        isComplex: result.isComplex,
    }
}
