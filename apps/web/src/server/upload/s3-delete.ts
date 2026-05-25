import type { S3Config } from "@/config/server"
import { createS3PresignedUrl, stripS4KeyPrefix } from "@/server/upload/s3-presign"

const S4_KEY_PREFIX = "s4key:"
const S4_KEY_REFERENCE_PATTERN = /s4key:([^\s"'<>),\]}]+)/g
const DELETE_EXPIRES_SECONDS = 60

type ArticleStorageContent = {
    contentJson?: string | null
    contentMd?: string | null
}

type FetchLike = (
    input: string | URL,
    init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "statusText" | "text">>

export type S3DeleteFailure = {
    errorMessage: string
    objectKey: string
    status?: number
}

export type S3DeleteSummary = {
    deletedObjectKeys: string[]
    failedObjectKeys: S3DeleteFailure[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function normalizeS4ObjectKey(value: string, userId: number): string | null {
    const objectKey = stripS4KeyPrefix(value).trim()
    if (!objectKey || !objectKey.startsWith(`uploads/${userId}/`)) {
        return null
    }
    return objectKey
}

function addS4ObjectKeyFromString(keys: Set<string>, value: string, userId: number) {
    if (value.startsWith(S4_KEY_PREFIX)) {
        const objectKey = normalizeS4ObjectKey(value.slice(S4_KEY_PREFIX.length), userId)
        if (objectKey) {
            keys.add(objectKey)
        }
    }

    for (const match of value.matchAll(S4_KEY_REFERENCE_PATTERN)) {
        const objectKey = normalizeS4ObjectKey(match[1] ?? "", userId)
        if (objectKey) {
            keys.add(objectKey)
        }
    }
}

function collectS4ObjectKeysFromJsonValue(keys: Set<string>, value: unknown, userId: number) {
    if (typeof value === "string") {
        addS4ObjectKeyFromString(keys, value, userId)
        return
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectS4ObjectKeysFromJsonValue(keys, item, userId)
        }
        return
    }

    if (isRecord(value)) {
        for (const item of Object.values(value)) {
            collectS4ObjectKeysFromJsonValue(keys, item, userId)
        }
    }
}

export function extractS4ObjectKeysFromArticleContent(
    content: ArticleStorageContent,
    userId: number,
): string[] {
    const keys = new Set<string>()

    if (content.contentMd) {
        addS4ObjectKeyFromString(keys, content.contentMd, userId)
    }

    if (content.contentJson?.trim()) {
        try {
            collectS4ObjectKeysFromJsonValue(keys, JSON.parse(content.contentJson), userId)
        } catch {
            addS4ObjectKeyFromString(keys, content.contentJson, userId)
        }
    }

    return [...keys]
}

export async function deleteS3Object(
    config: S3Config,
    objectKey: string,
    fetchImpl: FetchLike = fetch,
) {
    const presignedUrl = createS3PresignedUrl({
        ...config,
        expiresSeconds: DELETE_EXPIRES_SECONDS,
        method: "DELETE",
        objectKey,
    })
    const response = await fetchImpl(presignedUrl, { method: "DELETE" })

    if (response.ok || response.status === 404) {
        return
    }

    let body = ""
    try {
        body = await response.text()
    } catch {
        body = ""
    }

    const statusText = response.statusText ? ` ${response.statusText}` : ""
    const detail = body.trim() ? `：${body.trim().slice(0, 500)}` : ""
    const error = new Error(`S3 删除失败：HTTP ${response.status}${statusText}${detail}`)
    Object.assign(error, { status: response.status })
    throw error
}

export async function deleteS3Objects(
    config: S3Config,
    objectKeys: string[],
    fetchImpl: FetchLike = fetch,
): Promise<S3DeleteSummary> {
    const deletedObjectKeys: string[] = []
    const failedObjectKeys: S3DeleteFailure[] = []

    for (const objectKey of [...new Set(objectKeys)]) {
        try {
            await deleteS3Object(config, objectKey, fetchImpl)
            deletedObjectKeys.push(objectKey)
        } catch (error) {
            failedObjectKeys.push({
                errorMessage: error instanceof Error ? error.message : "未知错误",
                objectKey,
                status: isRecord(error) && typeof error.status === "number" ? error.status : undefined,
            })
        }
    }

    return { deletedObjectKeys, failedObjectKeys }
}
