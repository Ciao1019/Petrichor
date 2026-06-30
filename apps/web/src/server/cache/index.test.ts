import { beforeEach, describe, expect, it, vi } from "vitest"

const redisMocks = vi.hoisted(() => ({
    getRedis: vi.fn(),
}))

vi.mock("./redis", () => redisMocks)

import { cacheDrop, cacheDropByPrefix, cacheKey, cacheReadThrough } from "./index"

function createRedisMock(overrides: Record<string, unknown> = {}) {
    return {
        get: vi.fn(),
        set: vi.fn(async () => "OK"),
        del: vi.fn(async () => 1),
        scan: vi.fn(),
        ...overrides,
    }
}

describe("cacheKey", () => {
    it("拼接带命名空间的键", () => {
        expect(cacheKey("public", "about-profile")).toBe("petrichor:public:about-profile")
        expect(cacheKey("doclib", 7, "doc", 9)).toBe("petrichor:doclib:7:doc:9")
    })
})

describe("cacheReadThrough", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("Redis 未配置时直接回源、不缓存", async () => {
        redisMocks.getRedis.mockReturnValue(null)
        const loader = vi.fn(async () => ({ value: 1 }))

        await expect(cacheReadThrough("k", 60, loader)).resolves.toEqual({ value: 1 })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it("命中缓存时返回缓存值且不回源", async () => {
        const redis = createRedisMock({ get: vi.fn(async () => ({ value: "cached" })) })
        redisMocks.getRedis.mockReturnValue(redis)
        const loader = vi.fn(async () => ({ value: "fresh" }))

        await expect(cacheReadThrough("k", 60, loader)).resolves.toEqual({ value: "cached" })
        expect(loader).not.toHaveBeenCalled()
        expect(redis.set).not.toHaveBeenCalled()
    })

    it("未命中时回源并按 TTL 写回缓存", async () => {
        const redis = createRedisMock({ get: vi.fn(async () => null) })
        redisMocks.getRedis.mockReturnValue(redis)
        const loader = vi.fn(async () => ({ value: "fresh" }))

        await expect(cacheReadThrough("k", 120, loader)).resolves.toEqual({ value: "fresh" })
        expect(loader).toHaveBeenCalledTimes(1)
        expect(redis.set).toHaveBeenCalledWith("k", { value: "fresh" }, { ex: 120 })
    })

    it("读取缓存异常时回退回源，不抛错", async () => {
        const redis = createRedisMock({
            get: vi.fn(async () => {
                throw new Error("redis down")
            }),
        })
        redisMocks.getRedis.mockReturnValue(redis)
        const loader = vi.fn(async () => ({ value: "fresh" }))

        await expect(cacheReadThrough("k", 60, loader)).resolves.toEqual({ value: "fresh" })
        expect(loader).toHaveBeenCalledTimes(1)
    })

    it("写入缓存异常时仍返回回源结果", async () => {
        const redis = createRedisMock({
            get: vi.fn(async () => null),
            set: vi.fn(async () => {
                throw new Error("redis down")
            }),
        })
        redisMocks.getRedis.mockReturnValue(redis)
        const loader = vi.fn(async () => ({ value: "fresh" }))

        await expect(cacheReadThrough("k", 60, loader)).resolves.toEqual({ value: "fresh" })
    })
})

describe("cacheDrop", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("删除指定键", async () => {
        const redis = createRedisMock()
        redisMocks.getRedis.mockReturnValue(redis)

        await cacheDrop("a", "b")
        expect(redis.del).toHaveBeenCalledWith("a", "b")
    })

    it("无键或未配置 Redis 时不调用 del", async () => {
        const redis = createRedisMock()
        redisMocks.getRedis.mockReturnValue(redis)
        await cacheDrop()
        expect(redis.del).not.toHaveBeenCalled()

        redisMocks.getRedis.mockReturnValue(null)
        await cacheDrop("a")
        expect(redis.del).not.toHaveBeenCalled()
    })
})

describe("cacheDropByPrefix", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("基于 SCAN 游标循环删除匹配前缀的键", async () => {
        const redis = createRedisMock({
            scan: vi
                .fn()
                .mockResolvedValueOnce(["3", ["petrichor:doclib:7:libraries"]])
                .mockResolvedValueOnce(["0", ["petrichor:doclib:7:doc:9"]]),
        })
        redisMocks.getRedis.mockReturnValue(redis)

        await cacheDropByPrefix("petrichor:doclib:7:")

        expect(redis.scan).toHaveBeenCalledTimes(2)
        expect(redis.scan).toHaveBeenNthCalledWith(1, "0", { match: "petrichor:doclib:7:*", count: 200 })
        expect(redis.scan).toHaveBeenNthCalledWith(2, "3", { match: "petrichor:doclib:7:*", count: 200 })
        expect(redis.del).toHaveBeenCalledWith("petrichor:doclib:7:libraries")
        expect(redis.del).toHaveBeenCalledWith("petrichor:doclib:7:doc:9")
    })

    it("未配置 Redis 时静默跳过", async () => {
        redisMocks.getRedis.mockReturnValue(null)
        await expect(cacheDropByPrefix("petrichor:doclib:7:")).resolves.toBeUndefined()
    })
})
