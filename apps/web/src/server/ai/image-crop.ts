/**
 * 服务端图像裁剪封装。把 sharp（原生依赖）的引用收敛到这一处，
 * 便于在导入流程里按需裁剪嵌入图，也便于单测时替换实现。
 */

export interface PixelRect {
    left: number
    top: number
    width: number
    height: number
}

export interface ImageSize {
    width: number
    height: number
}

async function loadSharp() {
    const mod = await import("sharp")
    return mod.default
}

/** 读取图片像素尺寸。 */
export async function readImageSize(data: Buffer): Promise<ImageSize> {
    const sharp = await loadSharp()
    const meta = await sharp(data).metadata()
    if (!meta.width || !meta.height) {
        throw new Error("无法读取图片尺寸")
    }
    return { width: meta.width, height: meta.height }
}

/** 按像素矩形裁剪并编码为 JPEG。 */
export async function cropToJpeg(data: Buffer, rect: PixelRect): Promise<Buffer> {
    const sharp = await loadSharp()
    return sharp(data)
        .extract({
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        })
        .jpeg({ quality: 90 })
        .toBuffer()
}
