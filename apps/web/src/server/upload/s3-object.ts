import { getServerConfig } from "@/config/server"
import { HttpError } from "@/server/http/response"
import { createS3PresignedUrl, stripS4KeyPrefix } from "@/server/upload/s3-presign"

function getS3ConfigOrThrow() {
    const config = getServerConfig().s3
    if (!config) {
        throw new HttpError(500, "S3 存储未配置")
    }
    return config
}

/**
 * 生成对象的临时下载（GET）预签名 URL。
 * 用于把对象交给外部服务（如 MinerU）按 URL 拉取，避免文件经过本服务转发。
 */
export function presignS3DownloadUrl(objectKey: string): string {
    const config = getS3ConfigOrThrow()
    return createS3PresignedUrl({
        ...config,
        expiresSeconds: config.downloadExpireSeconds,
        method: "GET",
        objectKey: stripS4KeyPrefix(objectKey),
    })
}

/**
 * 服务端把二进制内容写入对象存储（通过预签名 PUT）。
 * 用于把 MinerU 解析结果中的图片转存到本系统对象存储。
 */
export async function putS3Object(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    const config = getS3ConfigOrThrow()
    const key = stripS4KeyPrefix(objectKey)
    const url = createS3PresignedUrl({
        ...config,
        expiresSeconds: config.uploadExpireSeconds,
        method: "PUT",
        objectKey: key,
    })
    const response = await fetch(url, {
        method: "PUT",
        // @types/node 的 BlobPart 不接受 ArrayBufferLike 视图，这里按运行时安全做断言
        body: new Blob([body as BlobPart], { type: contentType }),
        headers: { "Content-Type": contentType },
    })
    if (!response.ok) {
        throw new HttpError(502, `上传图片到对象存储失败：HTTP ${response.status}`)
    }
}
