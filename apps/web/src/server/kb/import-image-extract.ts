import { cropToJpeg, readImageSize, type ImageSize, type PixelRect } from "@/server/ai/image-crop"
import { uploadS3ObjectBytes } from "@/server/upload/s3-upload"
import type { S3ObjectBytes } from "@/server/upload/s3-fetch"

/**
 * 把多模态识别出的「带坐标的嵌入图占位符」替换为真正裁剪出来的图片。
 *
 * 识别提示词要求模型对照片/插图/图表输出 `![描述](image#bbox=x0,y0,x1,y1)`
 * （归一化坐标，0~1，原点左上）。这里据此从整页图裁剪出对应区域、上传 S3，
 * 再把占位符替换成 `s4key:{objectKey}`，使图像内容随文章一起保留。
 */

export interface Bbox {
    x0: number
    y0: number
    x1: number
    y1: number
}

export interface EmbeddedImagePlaceholder {
    /** 完整匹配文本，例如 `![柱状图](image#bbox=0.1,0.2,0.8,0.6)` */
    raw: string
    /** 在原 markdown 中的起始下标 */
    index: number
    alt: string
    bbox: Bbox | null
}

// 占位符语法：![alt](image) 或 ![alt](image#bbox=...)
const PLACEHOLDER_PATTERN = /!\[([^\]]*)\]\(image(?:#bbox=([^)]*))?\)/g

// 裁剪框外扩比例与最小边长（像素），避免裁得过紧把图切掉一圈。
const PADDING_RATIO = 0.01
const MIN_CROP_PX = 8

/** 解析 bbox 字符串 "x0,y0,x1,y1" 为归一化坐标，非法时返回 null。 */
export function parseBbox(raw: string | undefined): Bbox | null {
    if (!raw) return null
    const parts = raw.split(",").map((piece) => Number(piece.trim()))
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
        return null
    }
    const clamp = (value: number) => Math.min(1, Math.max(0, value))
    const x0 = clamp(parts[0])
    const y0 = clamp(parts[1])
    const x1 = clamp(parts[2])
    const y1 = clamp(parts[3])
    if (x1 <= x0 || y1 <= y0) {
        return null
    }
    return { x0, y0, x1, y1 }
}

/** 扫描出 markdown 中全部嵌入图占位符。 */
export function parseEmbeddedImagePlaceholders(markdown: string): EmbeddedImagePlaceholder[] {
    const result: EmbeddedImagePlaceholder[] = []
    for (const match of markdown.matchAll(PLACEHOLDER_PATTERN)) {
        result.push({
            raw: match[0],
            index: match.index ?? 0,
            alt: (match[1] ?? "").trim(),
            bbox: parseBbox(match[2]),
        })
    }
    return result
}

/** 归一化 bbox → 整页图上的像素裁剪框（含外扩与边界裁剪），过小则返回 null。 */
export function bboxToPixelRect(bbox: Bbox, size: ImageSize): PixelRect | null {
    const padX = size.width * PADDING_RATIO
    const padY = size.height * PADDING_RATIO
    const left = Math.max(0, Math.floor(bbox.x0 * size.width - padX))
    const top = Math.max(0, Math.floor(bbox.y0 * size.height - padY))
    const right = Math.min(size.width, Math.ceil(bbox.x1 * size.width + padX))
    const bottom = Math.min(size.height, Math.ceil(bbox.y1 * size.height + padY))
    const width = right - left
    const height = bottom - top
    if (width < MIN_CROP_PX || height < MIN_CROP_PX) {
        return null
    }
    return { left, top, width, height }
}

/** 占位符无法裁剪（缺坐标 / 裁剪失败）时的纯文本兜底，避免文章里出现坏图链接。 */
function toTextFallback(alt: string): string {
    return alt ? `*（图：${alt}）*` : ""
}

/** 用替换映射重建 markdown（按出现位置切片，正确处理重复占位符）。 */
function rebuildMarkdown(markdown: string, placeholders: EmbeddedImagePlaceholder[], replacements: string[]): string {
    let cursor = 0
    let output = ""
    placeholders.forEach((placeholder, i) => {
        output += markdown.slice(cursor, placeholder.index)
        output += replacements[i]
        cursor = placeholder.index + placeholder.raw.length
    })
    output += markdown.slice(cursor)
    return output
}

export interface EmbedImageDeps {
    measure: (data: Buffer) => Promise<ImageSize>
    crop: (data: Buffer, rect: PixelRect) => Promise<Buffer>
    upload: (userId: number, jpeg: Buffer) => Promise<string>
}

const defaultDeps: EmbedImageDeps = {
    measure: (data) => readImageSize(data),
    crop: (data, rect) => cropToJpeg(data, rect),
    upload: (userId, jpeg) =>
        uploadS3ObjectBytes({ userId, data: jpeg, ext: "jpg", contentType: "image/jpeg" }),
}

/**
 * 把整页 markdown 里的嵌入图占位符替换为裁剪后的真实图片。
 *
 * - 解析不到占位符：原样返回。
 * - 读取整页尺寸失败（如 sharp 不可用）：把所有占位符降级为纯文本，保证不留坏链接。
 * - 单个占位符裁剪/上传失败：仅该占位符降级为纯文本，其余正常。
 */
export async function embedExtractedImages(input: {
    userId: number
    markdown: string
    pageImage: S3ObjectBytes
    deps?: EmbedImageDeps
}): Promise<string> {
    const { userId, markdown, pageImage } = input
    const deps = input.deps ?? defaultDeps

    const placeholders = parseEmbeddedImagePlaceholders(markdown)
    if (placeholders.length === 0) {
        return markdown
    }

    let size: ImageSize
    try {
        size = await deps.measure(pageImage.data)
    } catch {
        // 整页图都读不了，把占位符统一降级为文本，避免坏图链接。
        return rebuildMarkdown(markdown, placeholders, placeholders.map((p) => toTextFallback(p.alt)))
    }

    const replacements = await Promise.all(
        placeholders.map(async (placeholder) => {
            const rect = placeholder.bbox ? bboxToPixelRect(placeholder.bbox, size) : null
            if (!rect) {
                return toTextFallback(placeholder.alt)
            }
            try {
                const jpeg = await deps.crop(pageImage.data, rect)
                const objectKey = await deps.upload(userId, jpeg)
                return `![${placeholder.alt}](s4key:${objectKey})`
            } catch {
                return toTextFallback(placeholder.alt)
            }
        }),
    )

    return rebuildMarkdown(markdown, placeholders, replacements)
}
