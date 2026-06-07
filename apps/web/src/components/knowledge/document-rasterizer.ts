"use client"

/**
 * 浏览器端把 PDF / Word 文档的「每一页」渲染成图片，
 * 供后续上传 S3 + 多模态识别使用。
 *
 * - PDF：pdfjs-dist 将每页绘制到 canvas（单层扫描件 / 双层文本件统一栅格化）。
 * - Word：docx-preview 渲染成分页 DOM，再用 html2canvas-pro 逐页截图。
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

export async function rasterizePdf(file: File, options: RasterizeOptions = {}): Promise<RasterizedPage[]> {
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
        const total = pdf.numPages
        const pages: RasterizedPage[] = []
        for (let pageNo = 1; pageNo <= total; pageNo++) {
            throwIfAborted(options.signal)
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
            options.onProgress?.(pageNo, total)
        }
        return pages
    } finally {
        await loadingTask.destroy()
    }
}

export async function rasterizeDocx(file: File, options: RasterizeOptions = {}): Promise<RasterizedPage[]> {
    const quality = options.quality ?? DEFAULT_QUALITY
    const maxEdge = options.maxEdgePx ?? DEFAULT_MAX_EDGE

    const [{ renderAsync }, html2canvasModule] = await Promise.all([
        import("docx-preview"),
        import("html2canvas-pro"),
    ])
    const html2canvas = html2canvasModule.default

    const container = document.createElement("div")
    container.style.position = "fixed"
    container.style.left = "-10000px"
    container.style.top = "0"
    container.style.background = "#ffffff"
    document.body.appendChild(container)

    try {
        await renderAsync(await file.arrayBuffer(), container, undefined, {
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            breakPages: true,
            useBase64URL: true,
        })
        throwIfAborted(options.signal)

        // docx-preview 把每一页渲染为 section.docx 节点
        const sections = Array.from(container.querySelectorAll<HTMLElement>("section.docx"))
        const pageNodes = sections.length > 0 ? sections : [container]
        const total = pageNodes.length
        const pages: RasterizedPage[] = []

        for (let index = 0; index < total; index++) {
            throwIfAborted(options.signal)
            const node = pageNodes[index]
            const rect = node.getBoundingClientRect()
            const scale = computeScale(rect.width, rect.height, maxEdge) * (window.devicePixelRatio || 1)
            const rendered = await html2canvas(node, {
                backgroundColor: "#ffffff",
                scale: Math.max(0.5, scale),
                useCORS: true,
                logging: false,
            })
            const blob = await canvasToBlob(rendered, quality)
            pages.push({ pageNo: index + 1, blob })
            options.onProgress?.(index + 1, total)
        }
        return pages
    } finally {
        container.remove()
    }
}

export async function rasterizeDocument(
    file: File,
    kind: "pdf" | "docx",
    options: RasterizeOptions = {},
): Promise<RasterizedPage[]> {
    return kind === "pdf" ? rasterizePdf(file, options) : rasterizeDocx(file, options)
}
