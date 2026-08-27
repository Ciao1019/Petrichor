/**
 * 🔒 API 速率限制 Route Handler 包装器
 *
 * 用于包装 Bun API Route，自动应用速率限制
 */

import type { AppRequest } from "@/server/http/request"
import { checkRateLimit, type RateLimitConfig } from "@/lib/rate-limit"
import { createLogger } from "@/lib/logger"

const logger = createLogger("api-rate-limit")

type RouteHandler = (
    req: AppRequest,
    context?: { params: Record<string, string> }
) => Promise<Response> | Response

/**
 * 从请求中提取客户端标识符（IP 地址）
 */
function getClientIdentifier(req: AppRequest): string {
    // 尝试从各种头部获取真实 IP
    const forwarded = req.headers.get("x-forwarded-for")
    const realIp = req.headers.get("x-real-ip")
    const cfConnectingIp = req.headers.get("cf-connecting-ip")

    if (forwarded) {
        return forwarded.split(",")[0].trim()
    }

    if (realIp) {
        return realIp
    }

    if (cfConnectingIp) {
        return cfConnectingIp
    }

    // 回退到默认标识符
    return "unknown"
}

/**
 * 预设的速率限制配置
 */
export const rateLimitPresets = {
    // 严格限制（登录、注册等敏感操作）
    strict: {
        maxRequests: 5,
        windowMs: 15 * 60 * 1000, // 15 分钟
    },
    // 中等限制（API 调用）
    moderate: {
        maxRequests: 100,
        windowMs: 60 * 1000, // 1 分钟
    },
    // 宽松限制（公开内容访问）
    lenient: {
        maxRequests: 300,
        windowMs: 60 * 1000, // 1 分钟
    },
}

/**
 * 速率限制包装器
 *
 * @example
 * ```ts
 * export const POST = withRateLimit(
 *   async (req) => {
 *     // 你的 API 逻辑
 *     return Response.json({ success: true })
 *   },
 *   { maxRequests: 10, windowMs: 60000 }
 * )
 * ```
 */
export function withRateLimit(
    handler: RouteHandler,
    config?: RateLimitConfig
): RouteHandler {
    return async (req, context) => {
        const identifier = getClientIdentifier(req)
        const { allowed, remaining, resetAt, limit } = checkRateLimit(identifier, config)

        // 添加速率限制响应头
        const headers = new Headers()
        headers.set("X-RateLimit-Limit", limit.toString())
        headers.set("X-RateLimit-Remaining", remaining.toString())
        headers.set("X-RateLimit-Reset", new Date(resetAt).toISOString())

        if (!allowed) {
            logger.warn({
                ip: identifier,
                path: req.urlObject.pathname,
                method: req.method,
                message: "Rate limit exceeded",
            })

            return Response.json(
                {
                    error: "Too Many Requests",
                    message: "请求过于频繁，请稍后再试",
                    retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
                },
                {
                    status: 429,
                    headers,
                }
            )
        }

        // 执行原始处理器
        const response = await handler(req, context)

        // 将速率限制头添加到响应
        for (const [key, value] of headers.entries()) {
            response.headers.set(key, value)
        }

        return response
    }
}

/**
 * 基于用户 ID 的速率限制（用于已认证的 API）
 */
export function withUserRateLimit(
    handler: RouteHandler,
    config?: RateLimitConfig
): RouteHandler {
    return async (req, context) => {
        // 这里需要根据你的认证系统获取用户 ID
        // 示例：从 session 或 JWT 中提取
        const userId = req.headers.get("x-user-id") || getClientIdentifier(req)

        const { allowed, remaining, resetAt, limit } = checkRateLimit(
            `user:${userId}`,
            config
        )

        const headers = new Headers()
        headers.set("X-RateLimit-Limit", limit.toString())
        headers.set("X-RateLimit-Remaining", remaining.toString())
        headers.set("X-RateLimit-Reset", new Date(resetAt).toISOString())

        if (!allowed) {
            return Response.json(
                {
                    error: "Too Many Requests",
                    message: "操作过于频繁，请稍后再试",
                    retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
                },
                {
                    status: 429,
                    headers,
                }
            )
        }

        const response = await handler(req, context)

        for (const [key, value] of headers.entries()) {
            response.headers.set(key, value)
        }

        return response
    }
}
