import fs from "node:fs/promises"
import path from "node:path"
import type { AppRequest } from "@/server/http/request"
import { getServerConfig } from "@/config/server"
import { HttpError } from "@/server/http/response"
import { stripS4KeyPrefix } from "@/server/upload/s3-presign"

const EXT_MIME: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".webp": "image/webp",
}

export interface LocalObjectBytes {
    data: Buffer
    mime: string
}

export function getLocalStorageDirOrNull() {
    return getServerConfig().localStorageDir
}

export function isLocalObjectStorageEnabled() {
    return Boolean(getLocalStorageDirOrNull())
}

export function buildLocalObjectUrl(request: AppRequest, objectKey: string) {
    return buildLocalObjectUrlFromBase(request.urlObject.origin, objectKey)
}

export function buildLocalObjectUrlFromBase(baseUrl: string, objectKey: string) {
    const url = new URL(`/api/upload/local/${encodeObjectKeyPath(objectKey)}`, baseUrl)
    return url.toString()
}

export function guessMimeFromObjectKey(objectKey: string): string {
    const ext = path.extname(stripS4KeyPrefix(objectKey)).toLowerCase()
    return EXT_MIME[ext] || "application/octet-stream"
}

function encodeObjectKeyPath(objectKey: string) {
    return stripS4KeyPrefix(objectKey)
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")
}

function assertSafeObjectKey(objectKey: string) {
    const key = stripS4KeyPrefix(objectKey).trim()
    const parts = key.split("/")

    if (!key || key.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
        throw new HttpError(400, "对象键不合法")
    }

    return { key, parts }
}

export function resolveLocalObjectPath(objectKey: string) {
    const baseDir = getLocalStorageDirOrNull()
    if (!baseDir) {
        throw new HttpError(500, "本地对象存储未配置")
    }

    const { parts } = assertSafeObjectKey(objectKey)
    const root = path.resolve(baseDir)
    const filePath = path.resolve(root, ...parts)
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        throw new HttpError(400, "对象键越界")
    }

    return filePath
}

export async function writeLocalObjectBytes(input: {
    contentType?: string | null
    data: Buffer
    objectKey: string
}) {
    const filePath = resolveLocalObjectPath(input.objectKey)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, input.data)
}

export async function readLocalObjectBytes(objectKey: string): Promise<LocalObjectBytes> {
    const filePath = resolveLocalObjectPath(objectKey)
    try {
        const data = await fs.readFile(filePath)
        return { data, mime: guessMimeFromObjectKey(objectKey) }
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            throw new HttpError(404, "文件不存在")
        }
        throw error
    }
}

export async function deleteLocalObject(objectKey: string) {
    const filePath = resolveLocalObjectPath(objectKey)
    try {
        await fs.unlink(filePath)
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return
        }
        throw error
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error
}
