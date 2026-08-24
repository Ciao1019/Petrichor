import pino, { type Logger as PinoLogger } from "pino"

const DEFAULT_LOG_LEVEL = process.env.NODE_ENV === "test"
    ? "silent"
    : process.env.NODE_ENV === "development" ? "debug" : "info"

/**
 * 服务端统一结构化日志。
 *
 * 不配置 transport，开发和生产都直接输出 JSON：Vercel、容器日志采集器和本地 jq
 * 都能无损消费；同时避免 pino-pretty 的 worker transport 干扰 Serverless 生命周期。
 */
export const logger = pino({
    level: process.env.LOG_LEVEL?.trim() || DEFAULT_LOG_LEVEL,
    base: {
        service: "petrichor-web",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
    },
    redact: {
        paths: [
            "password",
            "passwordHash",
            "token",
            "accessToken",
            "refreshToken",
            "apiKey",
            "authorization",
            "headers.authorization",
            "request.headers.authorization",
            "response.headers.set-cookie",
        ],
        censor: "[REDACTED]",
    },
})

export type Logger = PinoLogger

export function createLogger(name: string) {
    return logger.child({ module: name })
}

export function toLogError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}

export async function measurePerformance<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    const log = createLogger("performance").child({ operation: name })
    try {
        const result = await fn()
        log.info({ durationMs: Math.round(performance.now() - startedAt) }, "操作完成")
        return result
    } catch (error) {
        log.error({
            err: toLogError(error),
            durationMs: Math.round(performance.now() - startedAt),
        }, "操作失败")
        throw error
    }
}
