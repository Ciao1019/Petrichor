import { describe, expect, it, vi } from "vitest"

import type { S3Config } from "@/config/server"
import { deleteS3Object, deleteS3Objects, extractS4ObjectKeysFromArticleContent } from "./s3-delete"

const config: S3Config = {
    accessKeyId: "test-ak",
    bucket: "bucket",
    downloadExpireSeconds: 3600,
    endpoint: "https://s3.example.com",
    region: "cn-east-1",
    secretAccessKey: "test-sk",
    uploadExpireSeconds: 900,
}

describe("s3 delete helpers", () => {
    it("从文章 Markdown 和 Plate JSON 中提取当前用户的 S4 图片对象 key", () => {
        const keys = extractS4ObjectKeysFromArticleContent({
            contentJson: JSON.stringify([
                {
                    children: [{ text: "" }],
                    type: "img",
                    url: "s4key:uploads/42/from-json.png",
                },
                {
                    children: [{ text: "同一 key 去重" }],
                    type: "p",
                    url: "s4key:uploads/42/from-json.png",
                },
                {
                    children: [{ text: "" }],
                    type: "img",
                    url: "s4key:uploads/7/other-user.png",
                },
            ]),
            contentMd: "正文 ![图](s4key:uploads/42/from-md.jpg)",
        }, 42)

        expect(keys).toEqual([
            "uploads/42/from-md.jpg",
            "uploads/42/from-json.png",
        ])
    })

    it("JSON 损坏时回退为文本扫描", () => {
        const keys = extractS4ObjectKeysFromArticleContent({
            contentJson: '{"url":"s4key:uploads/42/broken-json.png"',
            contentMd: null,
        }, 42)

        expect(keys).toEqual(["uploads/42/broken-json.png"])
    })

    it("用 DELETE 方法请求预签名对象 URL", async () => {
        const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => {
            void _input
            void _init
            return {
                ok: true,
                status: 204,
                statusText: "No Content",
                text: async () => "",
            }
        })

        await deleteS3Object(config, "uploads/42/a.png", fetchImpl)

        expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining("X-Amz-Signature="),
            { method: "DELETE" },
        )
        const [url] = fetchImpl.mock.calls[0] as [string | URL, RequestInit?]
        expect(new URL(String(url)).host).toBe("bucket.s3.example.com")
    })

    it("批量删除时保留失败对象信息", async () => {
        const responses = [
            {
                ok: true,
                status: 204,
                statusText: "No Content",
                text: async () => "",
            },
            {
                ok: false,
                status: 403,
                statusText: "Forbidden",
                text: async () => "<Error><Code>AccessDenied</Code></Error>",
            },
        ]
        const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => {
            void _input
            void _init
            const response = responses.shift()
            if (!response) {
                throw new Error("未配置测试响应")
            }
            return response
        })

        const result = await deleteS3Objects(config, [
            "uploads/42/a.png",
            "uploads/42/b.png",
        ], fetchImpl)

        expect(result.deletedObjectKeys).toEqual(["uploads/42/a.png"])
        expect(result.failedObjectKeys).toEqual([
            expect.objectContaining({
                objectKey: "uploads/42/b.png",
                status: 403,
            }),
        ])
    })
})
