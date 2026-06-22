import { getServerConfig } from "@/config/server"
import { HttpError } from "@/server/http/response"
import { getLocalStorageDirOrNull, writeLocalObjectBytes } from "@/server/upload/local-storage"
import { buildS3ObjectKey, createS3PresignedUrl } from "@/server/upload/s3-presign"

/**
 * 服务端直接把一段字节上传到 S3（预签名 PUT 直传），返回对象键。
 * 与前端 useUploadFile 相同的存储约定：对象键形如 uploads/{userId}/{uuid}{ext}，
 * 文章中以 `s4key:{objectKey}` 引用，渲染时再换取有时效的下载链接。
 */
export async function uploadS3ObjectBytes(input: {
    userId: number
    data: Buffer
    ext: string
    contentType: string
}): Promise<string> {
    const ext = input.ext.startsWith(".") ? input.ext : `.${input.ext}`
    const objectKey = buildS3ObjectKey({ filename: `embedded${ext}`, userId: input.userId })

    if (getLocalStorageDirOrNull()) {
        await writeLocalObjectBytes({
            contentType: input.contentType,
            data: input.data,
            objectKey,
        })
        return objectKey
    }

    const config = getServerConfig().s3
    if (!config) {
        throw new HttpError(500, "S3 存储未配置")
    }

    const url = createS3PresignedUrl({
        ...config,
        expiresSeconds: config.uploadExpireSeconds,
        method: "PUT",
        objectKey,
    })
    const response = await fetch(url, {
        method: "PUT",
        // DOM fetch 的 BodyInit 不接受 Node Buffer，转成 Uint8Array（BufferSource）。
        body: new Uint8Array(input.data),
        headers: { "Content-Type": input.contentType },
    })
    if (!response.ok) {
        throw new HttpError(502, `上传裁剪图片失败：HTTP ${response.status}`)
    }
    return objectKey
}
