import { describe, expect, it } from "vitest"
import { loadServerConfigFromEnv } from "./server"

describe("loadServerConfigFromEnv", () => {
    it("服务端运行只要求数据库连接和 Session 密钥", () => {
        const config = loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            SESSION_SECRET: "x".repeat(32),
        })

        expect(config.databaseUrl).toBe("postgres://user:pass@example.supabase.co:5432/postgres")
        expect(config.s3).toBeNull()
        expect(config.session.expiresInSeconds).toBe(60 * 60 * 24 * 2)
    })

    it("读取 Session 与 S3 配置", () => {
        const config = loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            PETRICHOR_SESSION_EXPIRE_SECONDS: "604800",
            SESSION_SECRET: "x".repeat(32),
            S3_ACCESS_KEY_ID: "ak",
            S3_BUCKET: "bucket",
            S3_DOWNLOAD_EXPIRE_SECONDS: "600",
            S3_ENDPOINT: "s3.example.com",
            S3_REGION: "cn-east-1",
            S3_SECRET_ACCESS_KEY: "sk",
            S3_UPLOAD_EXPIRE_SECONDS: "300",
            S3_USE_SSL: "false",
        })

        expect(config.session.expiresInSeconds).toBe(604800)
        expect(config.s3).toEqual({
            accessKeyId: "ak",
            bucket: "bucket",
            downloadExpireSeconds: 600,
            endpoint: "http://s3.example.com",
            region: "cn-east-1",
            secretAccessKey: "sk",
            uploadExpireSeconds: 300,
        })
    })

    it("拒绝非法会话有效期", () => {
        expect(() =>
            loadServerConfigFromEnv({
                DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
                PETRICHOR_SESSION_EXPIRE_SECONDS: "0",
                SESSION_SECRET: "x".repeat(32),
            }),
        ).toThrow("PETRICHOR_SESSION_EXPIRE_SECONDS")
    })
})
