/**
 * 🔒 API 速率限制中间件
 *
 * 使用简单的内存存储实现速率限制
 * 生产环境建议使用 Redis 存储
 */

import { createLogger } from "@/lib/logger"

const logger = createLogger("rate-limit")

// 简单的内存存储（生产环境应使用 Redis）
interface RateLimitStore {
    [key: string]: {
        count: number
        resetAt: number
    }
}

const store: RateLimitStore = {}

export interface RateLimitConfig {
    /**
     * 时间窗口内允许的最大请求数
     */
    maxRequests: number
    /**
     * 时间窗口（毫秒）
     */
    windowMs: number
    /**
     * 生成限制键的函数（通常使用 IP 地址）
     */
    keyGenerator?: (identifier: string) => string
}

/**
 * 速率限制检查
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(
    identifier: string,
    config: RateLimitConfig = {
        maxRequests: 100,
        windowMs: 60 * 1000, // 1 分钟
    }
): {
    allowed: boolean
    remaining: number
    resetAt: number
    limit: number
} {
    const key = config.keyGenerator ? config.keyGenerator(identifier) : identifier
    const now = Date.now()

    // 获取或初始化存储条目
    let entry = store[key]

    if (!entry || now > entry.resetAt) {
        // 创建新的时间窗口
        entry = {
            count: 0,
            resetAt: now + config.windowMs,
        }
        store[key] = entry
    }

    // 增加计数
    entry.count++

    const allowed = entry.count <= config.maxRequests
    const remaining = Math.max(0, config.maxRequests - entry.count)

    if (!allowed) {
        logger.warn({
            identifier,
            count: entry.count,
            limit: config.maxRequests,
            message: "Rate limit exceeded",
        })
    }

    return {
        allowed,
        remaining,
        resetAt: entry.resetAt,
        limit: config.maxRequests,
    }
}

/**
 * 清理过期的限制记录
 */
export function cleanupExpiredRateLimits() {
    const now = Date.now()
    let cleaned = 0

    for (const key in store) {
        if (store[key].resetAt < now) {
            delete store[key]
            cleaned++
        }
    }

    if (cleaned > 0) {
        logger.debug({
            cleaned,
            message: "Cleaned up expired rate limit entries",
        })
    }
}

// 每分钟清理一次过期记录
if (typeof setInterval !== "undefined") {
    setInterval(cleanupExpiredRateLimits, 60 * 1000)
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
