import { describe, expect, it } from "vitest"
import { bm25Search } from "./bm25"
import { buildIndexTokens, buildQueryTokens, buildTsQuery } from "./tokenize"

const docs = [
    { id: "n1", title: "Redis 部署说明", summary: "生产环境部署", content: "使用 Sentinel 做高可用部署" },
    { id: "n2", title: "消息队列规范", summary: "Redis List 消费", content: "消费者 ACK 时机与重复消费问题" },
    { id: "n3", title: "前端构建流程", summary: "Vite 打包", content: "与 Redis 无关的构建说明" },
]

describe("bm25Search", () => {
    it("中文查询能命中相关文档", () => {
        const hits = bm25Search(docs, "Redis 部署")
        expect(hits[0].id).toBe("n1")
    })

    it("标题命中权重高于正文", () => {
        const titleHit = bm25Search(docs, "消息队列")
        expect(titleHit[0].id).toBe("n2")
    })

    it("整句无空格的中文查询同样可召回", () => {
        const hits = bm25Search(docs, "重复消费问题")
        expect(hits[0].id).toBe("n2")
    })

    it("无关查询不返回结果", () => {
        expect(bm25Search(docs, "量子计算")).toHaveLength(0)
    })

    it("空查询或空语料返回空", () => {
        expect(bm25Search(docs, "   ")).toHaveLength(0)
        expect(bm25Search([], "redis")).toHaveLength(0)
    })

    it("topK 限制返回数量", () => {
        expect(bm25Search(docs, "Redis", { topK: 1 })).toHaveLength(1)
    })

    it("字段权重可配置：把正文权重调高会改变排序", () => {
        const titleFirst = bm25Search(docs, "部署", { weights: { title: 10, summary: 1, content: 1 } })
        const contentFirst = bm25Search(docs, "构建说明", { weights: { title: 1, summary: 1, content: 10 } })
        expect(titleFirst[0].id).toBe("n1")
        expect(contentFirst[0].id).toBe("n3")
    })

    it("命中词元会被记录，便于诊断", () => {
        const [hit] = bm25Search(docs, "Sentinel")
        expect(hit.matchedTerms).toContain("sentinel")
    })
})

describe("分词", () => {
    it("中文按 bigram 展开", () => {
        expect(buildIndexTokens("部署说明")).toEqual(["部署", "署说", "说明"])
    })

    it("英文按词保留", () => {
        expect(buildIndexTokens("Redis Sentinel")).toEqual(["redis", "sentinel"])
    })

    it("中英混排两侧都能切出词元", () => {
        const tokens = buildIndexTokens("Redis部署")
        expect(tokens).toContain("部署")
        expect(tokens).toContain("redis")
    })

    it("查询词元去重", () => {
        expect(new Set(buildQueryTokens("部署部署")).size).toBe(buildQueryTokens("部署部署").length)
    })

    it("tsquery 用 | 连接词元", () => {
        expect(buildTsQuery(["redis", "部署"])).toBe("redis | 部署")
        expect(buildTsQuery([])).toBe("")
    })
})
