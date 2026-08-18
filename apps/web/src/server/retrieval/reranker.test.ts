import { describe, expect, it } from "vitest"
import { createReranker, NoopReranker, OpenAiCompatibleReranker, rerankWithFallback } from "./reranker"

const candidates = [
    { nodeKey: "a", title: "A", content: "内容 A" },
    { nodeKey: "b", title: "B", content: "内容 B" },
    { nodeKey: "c", title: "C", content: "内容 C" },
]

describe("Reranker", () => {
    it("未启用时返回 Noop，保持 RRF 顺序", async () => {
        const reranker = createReranker({
            enabled: false,
            provider: "openai-compatible",
            model: "m",
            topN: 2,
            timeoutMs: 100,
        })
        expect(reranker).toBeInstanceOf(NoopReranker)
        const result = await rerankWithFallback(reranker, "q", candidates, { topN: 2 })
        expect(result.applied).toBe(false)
        expect(result.items.map((item) => item.nodeKey)).toEqual(["a", "b"])
    })

    it("rerank 失败时回落到原顺序并记录错误", async () => {
        const reranker = new OpenAiCompatibleReranker({
            enabled: true,
            provider: "openai-compatible",
            model: "m",
            topN: 2,
            timeoutMs: 50,
            // 未配置 baseUrl → 必定抛错
        })
        const result = await rerankWithFallback(reranker, "q", candidates, { topN: 2 })
        expect(result.applied).toBe(false)
        expect(result.error).toContain("RAG_RERANK_BASE_URL")
        expect(result.items.map((item) => item.nodeKey)).toEqual(["a", "b"])
    })

    it("候选不足两条时跳过 rerank", async () => {
        const reranker = new OpenAiCompatibleReranker({
            enabled: true,
            provider: "openai-compatible",
            model: "m",
            topN: 5,
            timeoutMs: 50,
        })
        const result = await rerankWithFallback(reranker, "q", candidates.slice(0, 1))
        expect(result.applied).toBe(false)
        expect(result.items).toHaveLength(1)
    })

    it("rerank 成功时按新分数重排", async () => {
        const stub = {
            id: "stub",
            async rerank<T extends { nodeKey: string }>(_query: string, items: T[]) {
                return [...items].reverse().map((item, index) => ({ ...item, rerankScore: 1 - index * 0.1 }))
            },
        }
        const result = await rerankWithFallback(stub, "q", candidates, { topN: 3 })
        expect(result.applied).toBe(true)
        expect(result.items.map((item) => item.nodeKey)).toEqual(["c", "b", "a"])
        expect(result.items[0].rerankScore).toBe(1)
    })
})
