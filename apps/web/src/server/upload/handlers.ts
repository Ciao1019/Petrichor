import type { AppRequest } from "@/server/http/request"
import { z } from "zod"
import { createLogger } from "@/lib/logger"
import { getServerConfig } from "@/config/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { HttpError, ok, readJson, toErrorResponse } from "@/server/http/response"
import { buildLocalObjectUrl, isLocalObjectStorageEnabled } from "./local-storage"
import { buildS3ObjectKey, createS3PresignedUrl, stripS4KeyPrefix } from "./s3-presign"

const log = createLogger("upload-handler")

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

export async function presignPutObject(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = presignPutSchema.parse(await readJson(request))
        const objectKey = buildS3ObjectKey({
            filename: input.filename,
            userId: user.id,
        })

        if (isLocalObjectStorageEnabled()) {
            return ok({
                objectKey,
                presignedUrl: buildLocalObjectUrl(request, objectKey),
            })
        }

        const config = getS3ConfigOrThrow()
        const presignedUrl = createS3PresignedUrl({
            ...config,
            expiresSeconds: config.uploadExpireSeconds,
            method: "PUT",
            objectKey,
        })
        log.info({
            bucket: config.bucket,
            expiresSeconds: config.uploadExpireSeconds,
            objectKey,
            target: describeSignedUrlTarget(presignedUrl),
            userId: user.id,
        }, "生成上传预签名成功")

        return ok({
            objectKey,
            presignedUrl,
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function presignGetObject(request: AppRequest) {
    try {
        await requireCurrentUser(request)
        const input = presignGetSchema.parse(await readJson(request))

        if (isLocalObjectStorageEnabled()) {
            return ok({ url: buildLocalObjectUrl(request, stripS4KeyPrefix(input.objectKey)) })
        }

        const config = getS3ConfigOrThrow()
        const url = createS3PresignedUrl({
            ...config,
            expiresSeconds: config.downloadExpireSeconds,
            method: "GET",
            objectKey: stripS4KeyPrefix(input.objectKey),
        })

        return ok({ url })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function publicPresignGetObject(request: AppRequest) {
    try {
        const input = presignGetSchema.parse(await readJson(request))

        if (isLocalObjectStorageEnabled()) {
            return ok({ url: buildLocalObjectUrl(request, stripS4KeyPrefix(input.objectKey)) })
        }

        const config = getS3ConfigOrThrow()
        const url = createS3PresignedUrl({
            ...config,
            expiresSeconds: config.downloadExpireSeconds,
            method: "GET",
            objectKey: stripS4KeyPrefix(input.objectKey),
        })

        return ok({ url })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
