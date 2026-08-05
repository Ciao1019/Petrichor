"use client"

/**
 * 浏览器端把 PDF 的指定页渲染成图片，供多模态 OCR 兜底使用。
 *
 * 导入流程里 PDF 文字页由服务端 pdf-inspector 本地抽取，不需要图片；
 * 只有被判定为 needsOcr 的扫描页才会走到这里，因此按页号选择性渲染。
 */

export interface RasterizedPage {
    pageNo: number
    blob: Blob
}

export interface RasterizeOptions {
    /** 输出图片最长边像素上限，控制 base64 体积，默认 2000 */
    maxEdgePx?: number
    /** JPEG 质量（0-1），默认 0.85 */
    quality?: number
    onProgress?: (rendered: number, total: number) => void
    signal?: AbortSignal
}

const DEFAULT_MAX_EDGE = 2000
const DEFAULT_QUALITY = 0.85

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DOMException("文档渲染已取消", "AbortError")
    }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (blob) {
                    resolve(blob)
                } else {
                    reject(new Error("页面图片导出失败"))
                }
            },
            "image/jpeg",
            quality,
        )
    })
}

function computeScale(width: number, height: number, maxEdge: number): number {
    const longest = Math.max(width, height)
    if (longest <= maxEdge) {
        return 1
    }
    return maxEdge / longest
}

/**
 * 渲染 PDF 中指定的若干页（1-indexed）。
 * pageNos 为空数组时直接返回空结果，不会加载 pdfjs。
 */
export async function rasterizePdfPages(
    file: File,
    pageNos: number[],
    options: RasterizeOptions = {},
): Promise<RasterizedPage[]> {
    const targets = [...new Set(pageNos)].sort((a, b) => a - b)
    if (targets.length === 0) {
        return []
    }

    const maxEdge = options.maxEdgePx ?? DEFAULT_MAX_EDGE
    const quality = options.quality ?? DEFAULT_QUALITY

    const pdfjs = await import("pdfjs-dist")
    // 配置 worker（与 bundler 解耦，使用包内构建产物的 URL）
    const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString()

    const data = await file.arrayBuffer()
    const loadingTask = pdfjs.getDocument({ data })
    const pdf = await loadingTask.promise
    try {
        const total = targets.length
        const pages: RasterizedPage[] = []
        for (const pageNo of targets) {
            throwIfAborted(options.signal)
            if (pageNo < 1 || pageNo > pdf.numPages) {
                continue
            }
            const page = await pdf.getPage(pageNo)
            const baseViewport = page.getViewport({ scale: 1 })
            const scale = computeScale(baseViewport.width, baseViewport.height, maxEdge)
            const viewport = page.getViewport({ scale })

            const canvas = document.createElement("canvas")
            canvas.width = Math.max(1, Math.ceil(viewport.width))
            canvas.height = Math.max(1, Math.ceil(viewport.height))
            const context = canvas.getContext("2d")
            if (!context) {
                throw new Error("无法创建画布上下文")
            }
            // 扫描件可能透明，铺白底避免识别异常
            context.fillStyle = "#ffffff"
            context.fillRect(0, 0, canvas.width, canvas.height)

            await page.render({ canvas, canvasContext: context, viewport }).promise
            const blob = await canvasToBlob(canvas, quality)
            pages.push({ pageNo, blob })
            page.cleanup()
            options.onProgress?.(pages.length, total)
        }
        return pages
    } finally {
        await loadingTask.destroy()
    }
}
