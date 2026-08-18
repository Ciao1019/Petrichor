import { describe, expect, it } from "vitest"
import { rewriteQuery, shouldRewrite, toKeywordQuery } from "./query-rewrite"

describe("查询改写", () => {
    it("简单问题不改写", () => {
        expect(shouldRewrite("Redis 是什么")).toBe(false)
        const result = rewriteQuery("Redis 是什么")
        expect(result.applied).toBe(false)
        expect(result.subQueries).toEqual([])
    })

    it("复合问题拆成子查询", () => {
        const result = rewriteQuery("为什么我们的 Redis 消费会重复，以及现有设计在哪里做了幂等？")
        expect(result.applied).toBe(true)
        expect(result.subQueries.length).toBeGreaterThanOrEqual(2)
    })

    it("关键词查询去掉疑问词", () => {
        expect(toKeywordQuery("Redis 是什么？")).toBe("Redis")
        expect(toKeywordQuery("如何部署 Redis")).toContain("部署 Redis")
    })

    it("子查询数量受上限约束", () => {
        const result = rewriteQuery(
            "查一下 Redis 部署，再看看消费重复原因，还有 ACK 机制，以及幂等策略，另外确认版本兼容性",
            { maxSubQueries: 2 },
        )
        expect(result.subQueries.length).toBeLessThanOrEqual(2)
    })

    it("连续请求不受全局正则 lastIndex 影响", () => {
        const query = "查 Redis 部署，以及确认 ACK 机制"
        const decisions = Array.from({ length: 20 }, () => shouldRewrite(query))
        expect(new Set(decisions)).toEqual(new Set([true]))
    })
})
