import { z } from "zod"

export const DEFAULT_S3_REGION = "us-east-1"
export const DEFAULT_S3_UPLOAD_EXPIRE_SECONDS = 900
export const DEFAULT_S3_DOWNLOAD_EXPIRE_SECONDS = 3600
export const DEFAULT_SESSION_EXPIRE_SECONDS = 60 * 60 * 24 * 2

type EnvSource = Record<string, string | undefined>

const positiveIntegerFromEnv = (name: string, fallback: number) =>
    z
        .string()
        .optional()
        .transform((value, ctx) => {
            const raw = value?.trim()
            if (!raw) {
                return fallback
            }

            const parsed = Number(raw)
            if (!Number.isInteger(parsed) || parsed <= 0) {
                ctx.addIssue({
                    code: "custom",
                    message: `${name} 必须是正整数`,
                })
                return z.NEVER
            }

            return parsed
        })

const optionalTrimmedStringFromEnv = () =>
    z
        .string()
        .optional()
        .transform((value) => {
            const raw = value?.trim()
            return raw || null
        })

const trimmedStringFromEnv = (fallback: string) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const raw = value?.trim()
            return raw || fallback
        })

const booleanFromEnv = (name: string, fallback: boolean) =>
    z
        .string()
        .optional()
        .transform((value, ctx) => {
            const raw = value?.trim().toLowerCase()
            if (!raw) {
                return fallback
            }
            if (["true", "1", "yes", "y"].includes(raw)) {
                return true
            }
            if (["false", "0", "no", "n"].includes(raw)) {
                return false
            }

            ctx.addIssue({
                code: "custom",
                message: `${name} 必须是布尔值`,
            })
            return z.NEVER
        })

const s3EnvShape = {
    S3_ACCESS_KEY_ID: optionalTrimmedStringFromEnv(),
    S3_BUCKET: optionalTrimmedStringFromEnv(),
    S3_DOWNLOAD_EXPIRE_SECONDS: positiveIntegerFromEnv(
        "S3_DOWNLOAD_EXPIRE_SECONDS",
        DEFAULT_S3_DOWNLOAD_EXPIRE_SECONDS,
    ),
    S3_ENDPOINT: optionalTrimmedStringFromEnv(),
    S3_REGION: trimmedStringFromEnv(DEFAULT_S3_REGION),
    S3_SECRET_ACCESS_KEY: optionalTrimmedStringFromEnv(),
    S3_UPLOAD_EXPIRE_SECONDS: positiveIntegerFromEnv(
        "S3_UPLOAD_EXPIRE_SECONDS",
        DEFAULT_S3_UPLOAD_EXPIRE_SECONDS,
    ),
    S3_USE_SSL: booleanFromEnv("S3_USE_SSL", true),
}

const serverEnvSchema = z.object({
    DATABASE_URL: z.string().trim().min(1, "DATABASE_URL 不能为空"),
    ...s3EnvShape,
    PETRICHOR_SESSION_EXPIRE_SECONDS: positiveIntegerFromEnv(
        "PETRICHOR_SESSION_EXPIRE_SECONDS",
        DEFAULT_SESSION_EXPIRE_SECONDS,
    ),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET 至少需要 32 个字符"),
})

const formatConfigIssues = (issues: Array<{ message: string; path: PropertyKey[] }>) =>
    issues
        .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : ""
            return `${path}${issue.message}`
        })
        .join("; ")

export interface ServerConfig {
    databaseUrl: string
    s3: S3Config | null
    session: {
        expiresInSeconds: number
    }
    sessionSecret: string
}

export interface S3Config {
    accessKeyId: string
    bucket: string
    downloadExpireSeconds: number
    endpoint: string
    region: string
    secretAccessKey: string
    uploadExpireSeconds: number
}

function toS3Config(data: z.infer<z.ZodObject<typeof s3EnvShape>>): S3Config | null {
    if (!data.S3_BUCKET || !data.S3_ACCESS_KEY_ID || !data.S3_SECRET_ACCESS_KEY || !data.S3_ENDPOINT) {
        return null
    }

    let endpoint = data.S3_ENDPOINT
    if (!/^https?:\/\//.test(endpoint)) {
        endpoint = `${data.S3_USE_SSL ? "https" : "http"}://${endpoint}`
    }

    return {
        accessKeyId: data.S3_ACCESS_KEY_ID,
        bucket: data.S3_BUCKET,
        downloadExpireSeconds: data.S3_DOWNLOAD_EXPIRE_SECONDS,
        endpoint: endpoint.replace(/\/+$/, ""),
        region: data.S3_REGION,
        secretAccessKey: data.S3_SECRET_ACCESS_KEY,
        uploadExpireSeconds: data.S3_UPLOAD_EXPIRE_SECONDS,
    }
}

export function loadServerConfigFromEnv(env: EnvSource = process.env): ServerConfig {
    const parsed = serverEnvSchema.safeParse(env)

    if (!parsed.success) {
        throw new Error(`服务端配置无效：${formatConfigIssues(parsed.error.issues)}`)
    }

    return {
        databaseUrl: parsed.data.DATABASE_URL,
        s3: toS3Config(parsed.data),
        session: {
            expiresInSeconds: parsed.data.PETRICHOR_SESSION_EXPIRE_SECONDS,
        },
        sessionSecret: parsed.data.SESSION_SECRET,
    }
}

let cachedServerConfig: ServerConfig | null = null

export function getServerConfig(): ServerConfig {
    cachedServerConfig ??= loadServerConfigFromEnv()
    return cachedServerConfig
}
