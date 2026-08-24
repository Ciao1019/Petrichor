import { sql } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { getDb } from "@/server/db/client"
import { publicQaRateLimits } from "@/server/db/schema"
import { tooManyRequests } from "@/server/http/response"

/** 单浏览器（visitor-id）每小时提问上限——面向真实用户的主限流键 */
export const PUBLIC_QA_VISITOR_HOURLY_LIMIT = 10
/** 单 IP 每小时提问兜底上限——防止清除 visitor-id 后无限刷量 */
export const PUBLIC_QA_IP_HOURLY_LIMIT = 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 从常见反代头里取访客 IP（与 src/server/agent/handlers.ts 同款顺序）。 */
export function resolveClientIp(request: AppRequest): string | null {
    return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || request.headers.get("x-real-ip")?.trim()
        || request.headers.get("cf-connecting-ip")?.trim()
        || null
}

/** 读取并校验客户端 visitor-id（localStorage 里的 UUID）；非法返回 null。 */
export function resolveVisitorId(request: AppRequest): string | null {
    const raw = request.headers.get("x-petrichor-visitor-id")?.trim()
    return raw && UUID_PATTERN.test(raw) ? raw.toLowerCase() : null
}

/** 当前小时的窗口标识（UTC），形如 2026061013。 */
function hourBucket(now: Date): string {
    return [
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        String(now.getUTCDate()).padStart(2, "0"),
        String(now.getUTCHours()).padStart(2, "0"),
    ].join("")
}

/** 原子自增某个计数桶并返回自增后的计数。 */
async function bumpBucket(bucketKey: string, now: Date): Promise<number> {
    const [row] = await getDb()
        .insert(publicQaRateLimits)
        .values({ bucketKey, count: 1, windowStartedAt: now, updatedAt: now })
        .onConflictDoUpdate({
            target: publicQaRateLimits.bucketKey,
            set: {
                count: sql`${publicQaRateLimits.count} + 1`,
                updatedAt: now,
            },
        })
        .returning({ count: publicQaRateLimits.count })
    return row?.count ?? 1
}

export interface PublicQaQuotaResult {
    /** visitor 维度本小时剩余可提问次数 */
    remaining: number
    limit: number
}

/**
 * 复合键限流：visitor-id 主键（10/h）+ IP 兜底（60/h）。
 * 任一桶超限抛 429。无 visitor-id 时退化为「以 IP 作主键、按 10/h」。
 */
export async function consumePublicQaQuota(input: {
    visitorId: string | null
    ip: string | null
}): Promise<PublicQaQuotaResult> {
    const now = new Date()
    const bucket = hourBucket(now)
    const ipKey = input.ip ? `ip:${input.ip}:${bucket}` : null

    // 主键：有 visitor-id 用 visitor，否则退化为 IP。
    const primaryKey = input.visitorId
        ? `visitor:${input.visitorId}:${bucket}`
        : ipKey
    const primaryLimit = PUBLIC_QA_VISITOR_HOURLY_LIMIT

    // 兜底：仅在主键是 visitor 时，额外按 IP 设更高上限（两者是不同维度）。
    const backstopKey = input.visitorId ? ipKey : null

    let remaining = primaryLimit

    if (primaryKey) {
        const primaryCount = await bumpBucket(primaryKey, now)
        remaining = Math.max(0, primaryLimit - primaryCount)
        if (primaryCount > primaryLimit) {
            throw tooManyRequests(`本小时提问已达上限（${primaryLimit} 次），请稍后再试`)
        }
    }

    if (backstopKey) {
        const ipCount = await bumpBucket(backstopKey, now)
        if (ipCount > PUBLIC_QA_IP_HOURLY_LIMIT) {
            throw tooManyRequests("当前网络访问过于频繁，请稍后再试")
        }
    }

    return { remaining, limit: primaryLimit }
}
