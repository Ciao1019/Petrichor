import { createLogger, toLogError } from "@/lib/logger"
import { getRedis } from "./redis"

const log = createLogger("cache")
const localCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>()

/** 全站缓存键命名空间，避免与同库其它用途的键冲突。 */
const CACHE_NAMESPACE = "petrichor"

/**
 * 各类缓存的过期时间（秒）。
 * 统一 1 天：所有缓存的写操作都会主动失效，TTL 仅作兜底上限。
 */
const ONE_DAY_SECONDS = 60 * 60 * 24

export const CACHE_TTL_SECONDS = {
    /** 文档库：文档库列表 / 文件夹列表 / 文档列表（写操作会按用户主动失效，TTL 仅作兜底） */
    docLibraryCollection: ONE_DAY_SECONDS,
    /** 文档库：单文档详情（正文内容） */
    docDocumentDetail: ONE_DAY_SECONDS,
} as const

/** 构造带命名空间的缓存键，例如 cacheKey("public", "about-profile")。 */
export function cacheKey(...parts: Array<string | number>): string {
    return [CACHE_NAMESPACE, ...parts].join(":")
}

/**
 * 读穿透（cache-aside）：
 * 1. 命中缓存直接返回；
 * 2. 未命中则回源、写回缓存并设置 TTL。
 *
 * Redis 未配置或读写异常时，一律回退到直接回源，
 * **绝不因缓存层故障而中断或拖垮业务请求**。
 */
export async function cacheReadThrough<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
): Promise<T> {
    const redis = getRedis()
    if (!redis) {
        const now = Date.now()
        const cached = localCache.get(key)
        if (cached && cached.expiresAt > now) {
            return cached.value as Promise<T>
        }

        const value = loader()
        localCache.set(key, {
            expiresAt: now + ttlSeconds * 1000,
            value,
        })
        value.catch(() => localCache.delete(key))
        return value
    }

    try {
        // Upstash SDK 会自动反序列化为原始 JS 类型
        const cached = await redis.get<T>(key)
        if (cached !== null && cached !== undefined) {
            return cached
        }
    } catch (error) {
        log.warn({ key, err: toLogError(error) }, "读取缓存失败，回退直查")
        return loader()
    }

    const fresh = await loader()

    try {
        // Upstash SDK 会自动序列化对象/数组
        await redis.set(key, fresh as unknown, { ex: ttlSeconds })
    } catch (error) {
        log.warn({ key, err: toLogError(error) }, "写入缓存失败，已返回回源结果")
    }

    return fresh
}

/** 删除一个或多个缓存键。Redis 未配置或异常时静默跳过。 */
export async function cacheDrop(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
        return
    }
    for (const key of keys) {
        localCache.delete(key)
    }

    const redis = getRedis()
    if (!redis) {
        return
    }
    try {
        await redis.del(...keys)
    } catch (error) {
        log.warn({ keys, err: toLogError(error) }, "删除缓存失败")
    }
}

/**
 * 按前缀批量删除缓存键（基于 SCAN，避免阻塞 Redis）。
 * 用于失效一组同前缀的键，例如某用户文档库下的全部缓存。
 */
export async function cacheDropByPrefix(prefix: string): Promise<void> {
    for (const key of localCache.keys()) {
        if (key.startsWith(prefix)) {
            localCache.delete(key)
        }
    }

    const redis = getRedis()
    if (!redis) {
        return
    }
    try {
        let cursor = "0"
        const pattern = `${prefix}*`
        do {
            const [next, keys] = await redis.scan(cursor, { match: pattern, count: 200 })
            cursor = next
            if (keys.length > 0) {
                await redis.del(...keys)
            }
        } while (cursor !== "0")
    } catch (error) {
        log.warn({ prefix, err: toLogError(error) }, "按前缀删除缓存失败")
    }
}
