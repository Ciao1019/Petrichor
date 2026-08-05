export type ImportSourceType = "pdf"

export type ImportJobStatus = "pending" | "processing" | "completed" | "failed" | "canceled"

export type ImportPageStatus = "pending" | "done" | "failed"

/** 页内容的来源：本地 PDF 抽取，还是多模态识别兜底。 */
export type ImportPageExtractedBy = "pdf" | "vision"

export function parseImportSourceType(raw: unknown): ImportSourceType | null {
    const value = String(raw ?? "").trim().toLowerCase()
    return value === "pdf" ? value : null
}

/**
 * 按页码顺序合并各页转写出的 Markdown，组成单篇文章正文。
 * 跳过空白页，页之间用空行分隔，避免相邻段落粘连。
 */
export function mergePageMarkdown(pages: Array<{ pageNo: number; markdown: string | null }>): string {
    return [...pages]
        .sort((a, b) => a.pageNo - b.pageNo)
        .map((page) => (page.markdown ?? "").trim())
        .filter((text) => text.length > 0)
        .join("\n\n")
}

/**
 * 根据各页状态推导任务整体状态。
 * - 还有 pending：processing
 * - 全部 done：completed
 * - 无 pending 但存在 failed：failed
 */
export function deriveJobStatus(pageStatuses: ImportPageStatus[]): ImportJobStatus {
    if (pageStatuses.length === 0) {
        return "pending"
    }
    if (pageStatuses.some((status) => status === "pending")) {
        return "processing"
    }
    if (pageStatuses.some((status) => status === "failed")) {
        return "failed"
    }
    return "completed"
}

export function countProcessedPages(pageStatuses: ImportPageStatus[]): number {
    return pageStatuses.filter((status) => status !== "pending").length
}
