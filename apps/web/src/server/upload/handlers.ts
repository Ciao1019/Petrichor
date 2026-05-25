import { NextRequest } from "next/server"
import { z } from "zod"
import { getServerConfig } from "@/config/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { HttpError, ok, readJson, toErrorResponse } from "@/server/http/response"
import { buildS3ObjectKey, createS3PresignedUrl, stripS4KeyPrefix } from "./s3-presign"

const presignPutSchema = z.object({
    filename: z.string().trim().min(1),
})

const presignGetSchema = z.object({
    objectKey: z.string().trim().min(1),
})

function describeSignedUrlTarget(rawUrl: string) {
    const url = new URL(rawUrl)
    return {
        hasQuery: url.search.length > 0,
        origin: url.origin,
        pathname: url.pathname,
    }
}

function getS3ConfigOrThrow() {
    const config = getServerConfig().s3
    if (!config) {
        throw new HttpError(500, "S3 存储未配置")
    }
    return config
}

export async function presignPutObject(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = presignPutSchema.parse(await readJson(request))
        const config = getS3ConfigOrThrow()
        const objectKey = buildS3ObjectKey({
            filename: input.filename,
            userId: user.id,
        })
        const presignedUrl = createS3PresignedUrl({
            ...config,
            expiresSeconds: config.uploadExpireSeconds,
            method: "PUT",
            objectKey,
        })
        console.info("[S4 upload] 生成上传预签名成功", {
            bucket: config.bucket,
            expiresSeconds: config.uploadExpireSeconds,
            objectKey,
            target: describeSignedUrlTarget(presignedUrl),
            userId: user.id,
        })

        return ok({
            objectKey,
            presignedUrl,
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function presignGetObject(request: NextRequest) {
    try {
        await requireCurrentUser(request)
        const input = presignGetSchema.parse(await readJson(request))
        const config = getS3ConfigOrThrow()
        const url = createS3PresignedUrl({
            ...config,
            expiresSeconds: config.downloadExpireSeconds,
            method: "GET",
            objectKey: stripS4KeyPrefix(input.objectKey),
        })

        return ok({ url })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function publicPresignGetObject(request: NextRequest) {
    try {
        const input = presignGetSchema.parse(await readJson(request))
        const config = getS3ConfigOrThrow()
        const url = createS3PresignedUrl({
            ...config,
            expiresSeconds: config.downloadExpireSeconds,
            method: "GET",
            objectKey: stripS4KeyPrefix(input.objectKey),
        })

        return ok({ url })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
