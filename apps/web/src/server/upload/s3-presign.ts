import { createHash, createHmac, randomUUID } from "node:crypto"
import path from "node:path"
import type { S3Config } from "@/config/server"

type HttpMethod = "DELETE" | "GET" | "PUT"

interface BuildS3ObjectKeyInput {
    filename: string
    userId: number
    uuid?: string
}

interface CreateS3PresignedUrlInput extends Omit<S3Config, "downloadExpireSeconds" | "uploadExpireSeconds"> {
    expiresSeconds: number
    method: HttpMethod
    now?: Date
    objectKey: string
}

export function stripS4KeyPrefix(key: string): string {
    return key.trim().replace(/^s4key:/, "")
}

export function buildS3ObjectKey(input: BuildS3ObjectKeyInput): string {
    const ext = path.extname(input.filename).toLowerCase()
    return `uploads/${input.userId}/${input.uuid ?? randomUUID()}${ext}`
}

function sha256Hex(value: string) {
    return createHash("sha256").update(value).digest("hex")
}

function hmac(key: Buffer | string, value: string) {
    return createHmac("sha256", key).update(value).digest()
}

function hmacHex(key: Buffer | string, value: string) {
    return createHmac("sha256", key).update(value).digest("hex")
}

function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string) {
    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, region)
    const kService = hmac(kRegion, "s3")
    return hmac(kService, "aws4_request")
}

function toAmzDate(date: Date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "")
}

function encodePathname(objectKey: string) {
    return `/${objectKey.split("/").map((part) => encodeURIComponent(part)).join("/")}`
}

function encodeQuery(value: string) {
    return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalQuery(params: Array<[string, string]>) {
    return [...params]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${encodeQuery(key)}=${encodeQuery(value)}`)
        .join("&")
}

function virtualHostUrl(endpoint: string, bucket: string) {
    const parsed = new URL(endpoint)
    if (parsed.hostname === bucket || parsed.hostname.startsWith(`${bucket}.`)) {
        return parsed
    }
    parsed.hostname = `${bucket}.${parsed.hostname}`
    return parsed
}

export function createS3PresignedUrl(input: CreateS3PresignedUrlInput): string {
    const now = input.now ?? new Date()
    const amzDate = toAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)
    const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`
    const baseUrl = virtualHostUrl(input.endpoint, input.bucket)
    const host = baseUrl.host
    const canonicalUri = encodePathname(stripS4KeyPrefix(input.objectKey))
    const params: Array<[string, string]> = [
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", String(input.expiresSeconds)],
        ["X-Amz-SignedHeaders", "host"],
    ]
    const query = canonicalQuery(params)
    const canonicalRequest = [
        input.method,
        canonicalUri,
        query,
        `host:${host}\n`,
        "host",
        "UNSIGNED-PAYLOAD",
    ].join("\n")
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join("\n")
    const signature = hmacHex(deriveSigningKey(input.secretAccessKey, dateStamp, input.region), stringToSign)

    baseUrl.pathname = canonicalUri
    baseUrl.search = `${query}&X-Amz-Signature=${signature}`
    return baseUrl.toString()
}
