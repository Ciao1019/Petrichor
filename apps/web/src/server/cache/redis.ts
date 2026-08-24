import { Redis } from "@upstash/redis"
import { createLogger } from "@/lib/logger"

const log = createLogger("cache-redis")

/**
 * 缓存客户端单例。
 * - `undefined`：尚未初始化
 * - `null`：未配置 Upstash 凭据，缓存层禁用（调用方回源直查）
 * - `Redis`：可用客户端
 */
let client: Redis | null | undefined

/**
 * 懒加载 Upstash Redis 客户端。
 *
 * 端点与令牌从环境变量（配置文件）读取：
 * - `UPSTASH_REDIS_REST_URL`
 * - `UPSTASH_REDIS_REST_TOKEN`
 *
 * 未配置时返回 `null`，调用方应优雅降级到直接回源——
 * 这样在缓存不可用或本地/测试环境下功能完全不受影响。
 */
export function getRedis(): Redis | null {
    if (client !== undefined) {
        return client
    }

    const url = process.env.UPSTASH_REDIS_REST_URL?.trim()
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()

    if (!url || !token) {
        client = null
        return client
    }

    client = new Redis({ url, token })
    log.info("Upstash Redis 缓存已启用")
    return client
}

/** 测试用：重置已缓存的客户端单例。 */
export function resetRedisClientForTest() {
    client = undefined
}
