import { describe, expect, it } from "vitest"
import { buildS3ObjectKey, createS3PresignedUrl, stripS4KeyPrefix } from "./s3-presign"

describe("s3 presign", () => {
    it("按 Go 逻辑生成用户隔离的 uploads 对象 key，并保留小写扩展名", () => {
        const key = buildS3ObjectKey({
            filename: "Avatar.PNG",
            userId: 42,
            uuid: "00000000-0000-4000-8000-000000000000",
        })

        expect(key).toBe("uploads/42/00000000-0000-4000-8000-000000000000.png")
    })

    it("移除前端传入的 s4key 前缀", () => {
        expect(stripS4KeyPrefix("s4key:uploads/1/a.png")).toBe("uploads/1/a.png")
        expect(stripS4KeyPrefix("uploads/1/a.png")).toBe("uploads/1/a.png")
    })

    it("生成虚拟主机风格 S3 预签名 URL，且不包含 x-id 参数", () => {
        const url = createS3PresignedUrl({
            accessKeyId: "test-ak",
            bucket: "bucket",
            endpoint: "https://s3.example.com",
            expiresSeconds: 900,
            method: "PUT",
            now: new Date("2026-04-27T00:00:00.000Z"),
            objectKey: "uploads/1/a b.png",
            region: "cn-east-1",
            secretAccessKey: "test-sk",
        })

        const parsed = new URL(url)
        expect(parsed.host).toBe("bucket.s3.example.com")
        expect(parsed.pathname).toBe("/uploads/1/a%20b.png")
        expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")
        expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900")
        expect(parsed.searchParams.has("x-id")).toBe(false)
        expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true)
    })

    it("endpoint 已经包含桶名时不重复拼接桶名前缀", () => {
        const url = createS3PresignedUrl({
            accessKeyId: "test-ak",
            bucket: "blog-1",
            endpoint: "https://blog-1.s3.bitiful.net",
            expiresSeconds: 900,
            method: "PUT",
            now: new Date("2026-04-27T00:00:00.000Z"),
            objectKey: "uploads/2/a.png",
            region: "cn-east-1",
            secretAccessKey: "test-sk",
        })

        const parsed = new URL(url)
        expect(parsed.host).toBe("blog-1.s3.bitiful.net")
        expect(parsed.pathname).toBe("/uploads/2/a.png")
    })
})
