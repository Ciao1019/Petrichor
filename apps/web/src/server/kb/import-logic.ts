export type ImportSourceType = "pdf" | "docx"

export type ImportJobStatus = "pending" | "processing" | "completed" | "failed" | "canceled"

export function parseImportSourceType(raw: unknown): ImportSourceType | null {
    const value = String(raw ?? "").trim().toLowerCase()
    return value === "pdf" || value === "docx" ? value : null
}

/**
 * 把 MinerU 解析出的 Markdown 中对相对图片路径的引用替换为转存后的可访问地址。
 * 按引用长度从长到短替换，避免短路径误伤长路径。
 */
export function rewriteImageRefs(markdown: string, mapping: Array<{ ref: string; url: string }>): string {
    const ordered = [...mapping].sort((a, b) => b.ref.length - a.ref.length)
    let result = markdown
    for (const { ref, url } of ordered) {
        if (!ref) continue
        result = result.split(ref).join(url)
    }
    return result
}
