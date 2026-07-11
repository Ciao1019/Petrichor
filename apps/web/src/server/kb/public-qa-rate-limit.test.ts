import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

vi.mock("@/server/db/client", () => dbMocks)

import {
    consumePublicQaQuota,
    PUBLIC_QA_IP_HOURLY_LIMIT,
    PUBLIC_QA_VISITOR_HOURLY_LIMIT,
    resolveClientIp,
    resolveVisitorId,
} from "./public-qa-rate-limit"

/** 内存版计数桶，模拟 insert ... on conflict do update count = count + 1 returning count。 */
function createFakeDb() {
    const store = new Map<string, number>()
    const db = {
        insert: () => ({
            values: (v: { bucketKey: string }) => ({
                onConflictDoUpdate: () => ({
                    returning: async () => {
                        const next = (store.get(v.bucketKey) ?? 0) + 1
                        store.set(v.bucketKey, next)
                        return [{ count: next }]
                    },
                }),
            }),
        }),
    }
    return { db, store }
}

function fakeRequest(headers: Record<string, string>): { headers: { get(name: string): string | null } } {
    const normalized = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
        headers: {
            get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
        },
    }
}

const VISITOR = "11111111-2222-4333-8444-555555555555"

describe("公开问答限流", () => {
    beforeEach(() => {
        const { db } = createFakeDb()
        dbMocks.getDb.mockReturnValue(db)
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-06-10T10:30:00Z"))
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.clearAllMocks()
    })

    it("visitor 桶在同一小时内累加，第 11 次触发 429", async () => {
        for (let i = 1; i <= PUBLIC_QA_VISITOR_HOURLY_LIMIT; i += 1) {
            const result = await consumePublicQaQuota({ visitorId: VISITOR, ip: "1.2.3.4" })
            expect(result.remaining).toBe(PUBLIC_QA_VISITOR_HOURLY_LIMIT - i)
        }
        await expect(consumePublicQaQuota({ visitorId: VISITOR, ip: "1.2.3.4" }))
            .rejects.toMatchObject({ status: 429 })
    })

    it("跨小时窗口重置后额度恢复", async () => {
        for (let i = 0; i < PUBLIC_QA_VISITOR_HOURLY_LIMIT; i += 1) {
            await consumePublicQaQuota({ visitorId: VISITOR, ip: "1.2.3.4" })
        }
        await expect(consumePublicQaQuota({ visitorId: VISITOR, ip: "1.2.3.4" }))
            .rejects.toMatchObject({ status: 429 })

        // 进入下一个小时桶。
        vi.setSystemTime(new Date("2026-06-10T11:05:00Z"))
        const result = await consumePublicQaQuota({ visitorId: VISITOR, ip: "1.2.3.4" })
        expect(result.remaining).toBe(PUBLIC_QA_VISITOR_HOURLY_LIMIT - 1)
    })

    it("IP 兜底桶超过上限触发 429（即便每次换 visitor-id）", async () => {
        for (let i = 1; i <= PUBLIC_QA_IP_HOURLY_LIMIT; i += 1) {
            await consumePublicQaQuota({ visitorId: `0000000${i}-2222-4333-8444-555555555555`.slice(-36), ip: "8.8.8.8" })
        }
        await expect(consumePublicQaQuota({ visitorId: VISITOR, ip: "8.8.8.8" }))
            .rejects.toMatchObject({ status: 429 })
    })

    it("缺少 visitor-id 时退化为按 IP 计 10 次/小时", async () => {
        for (let i = 0; i < PUBLIC_QA_VISITOR_HOURLY_LIMIT; i += 1) {
            await consumePublicQaQuota({ visitorId: null, ip: "9.9.9.9" })
        }
        await expect(consumePublicQaQuota({ visitorId: null, ip: "9.9.9.9" }))
            .rejects.toMatchObject({ status: 429 })
    })
})

describe("公开问答请求标识解析", () => {
    it("resolveVisitorId 仅接受合法 UUID 并小写化", () => {
        expect(resolveVisitorId(fakeRequest({ "x-petrichor-visitor-id": VISITOR.toUpperCase() }) as never)).toBe(VISITOR)
        expect(resolveVisitorId(fakeRequest({ "x-petrichor-visitor-id": "not-a-uuid" }) as never)).toBeNull()
        expect(resolveVisitorId(fakeRequest({}) as never)).toBeNull()
    })

    it("resolveClientIp 按反代头优先级取第一个 IP", () => {
        expect(resolveClientIp(fakeRequest({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" }) as never)).toBe("203.0.113.1")
        expect(resolveClientIp(fakeRequest({ "x-real-ip": "203.0.113.9" }) as never)).toBe("203.0.113.9")
        expect(resolveClientIp(fakeRequest({}) as never)).toBeNull()
    })
})
