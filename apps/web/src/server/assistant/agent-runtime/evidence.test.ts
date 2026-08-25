import { describe, expect, it } from "vitest"
import {
    canonicalUrl,
    contentHash,
    EvidenceStore,
    freshnessFromDate,
    normalizeTitle,
    scoreEvidence,
    scoreSourceQuality,
} from "./evidence"

describe("EvidenceStore 去重", () => {
    it("同 nodeKey 视为同一条证据并合并信息", () => {
        const store = new EvidenceStore()
        store.add({
            source: "knowledge",
            content: "短片段",
            metadata: { nodeKey: "a1-3" },
            relevance: 0.4,
        })
        store.add({
            source: "knowledge",
            title: "Redis 部署",
            content: "更完整的一段正文内容",
            metadata: { nodeKey: "a1-3", articleId: "1" },
            relevance: 0.9,
        })

        expect(store.size).toBe(1)
        const [evidence] = store.all
        expect(evidence.title).toBe("Redis 部署")
        expect(evidence.content).toBe("更完整的一段正文内容")
        expect(evidence.relevance).toBe(0.9)
        expect(evidence.metadata?.articleId).toBe("1")
    })

    it("URL 归一后同一页面只保留一条", () => {
        const store = new EvidenceStore()
        store.add({ source: "web", content: "a", url: "https://redis.io/docs/latest/?utm_source=x" })
        store.add({ source: "web", content: "b", url: "http://www.redis.io/docs/latest" })
        expect(store.size).toBe(1)
    })

    it("没有稳定来源标识时，正文相同但排版不同仍会去重", () => {
        const store = new EvidenceStore()
        store.add({ source: "tool", content: "Redis  使用  Streams。" })
        store.add({ source: "tool", content: "Redis 使用 Streams." })
        expect(store.size).toBe(1)
    })

    it("正文相同但 nodeKey 不同的章节必须各自保留", () => {
        const store = new EvidenceStore()
        store.add({
            source: "knowledge",
            title: "安装",
            content: "同一篇文章的回退正文",
            sourceId: "a1-install",
            metadata: { nodeKey: "a1-install", articleId: "1" },
        })
        store.add({
            source: "knowledge",
            title: "卸载",
            content: "同一篇文章的回退正文",
            sourceId: "a1-uninstall",
            metadata: { nodeKey: "a1-uninstall", articleId: "1" },
        })

        expect(store.size).toBe(2)
        expect(store.all.map((item) => item.metadata?.nodeKey)).toEqual(["a1-install", "a1-uninstall"])
        expect(store.all.map((item) => store.citationIndex(item.id))).toEqual([1, 1])
    })

    it("同一文章的多个章节共享来源编号，不同文章才递增", () => {
        const store = new EvidenceStore()
        const first = store.add({
            source: "knowledge",
            content: "定义",
            sourceId: "mole-definition",
            metadata: { knowledgeBaseId: "1", articleId: "10", nodeKey: "mole-definition" },
        })
        const second = store.add({
            source: "knowledge",
            content: "核心功能",
            sourceId: "mole-features",
            metadata: { knowledgeBaseId: "1", articleId: "10", nodeKey: "mole-features" },
        })
        const third = store.add({
            source: "knowledge",
            content: "另一篇文章",
            sourceId: "other",
            metadata: { knowledgeBaseId: "1", articleId: "11", nodeKey: "other" },
        })

        expect([first, second, third].map((item) => store.citationIndex(item.id))).toEqual([1, 1, 2])
    })

    it("正文相同但 URL 不同的外部来源不会丢失出处", () => {
        const store = new EvidenceStore()
        store.add({ source: "web", content: "相同的转载正文", url: "https://a.com/1" })
        store.add({ source: "web", content: "相同的转载正文", url: "https://b.com/2" })
        expect(store.size).toBe(2)
    })

    it("不同来源的不同内容不会被误合并", () => {
        const store = new EvidenceStore()
        store.add({ source: "knowledge", title: "内部方案", content: "内部使用 List 做队列" })
        store.add({ source: "web", title: "官方文档", content: "官方推荐使用 Streams" })
        expect(store.size).toBe(2)
    })

    it("merge 会为子代理证据重新分配 id 并参与去重", () => {
        const store = new EvidenceStore()
        store.add({ source: "web", content: "同一段内容", url: "https://a.com/x" })
        const merged = store.merge([
            { id: "old", createdAt: 1, source: "web", content: "同一段内容", url: "https://a.com/x" },
        ])
        expect(store.size).toBe(1)
        expect(merged[0].id).not.toBe("old")
    })

    it("topN 按综合分排序", () => {
        const store = new EvidenceStore()
        store.add({ source: "web", content: "低相关", url: "https://a.com/1", relevance: 0.1 })
        store.add({ source: "web", content: "高相关", url: "https://a.com/2", relevance: 0.95 })
        expect(store.topN(1)[0].content).toBe("高相关")
    })
})

describe("证据质量与新鲜度", () => {
    it("官方文档站点质量高于普通博客", () => {
        expect(scoreSourceQuality({ source: "web", content: "", url: "https://docs.redis.io/x" }))
            .toBeGreaterThan(scoreSourceQuality({ source: "web", content: "", url: "https://medium.com/x" }))
    })

    it("内部知识库默认高可信", () => {
        expect(scoreSourceQuality({ source: "knowledge", content: "" })).toBeGreaterThan(0.8)
    })

    it("新内容比旧内容新鲜度高", () => {
        const now = Date.parse("2026-01-01T00:00:00Z")
        const fresh = freshnessFromDate("2025-12-01T00:00:00Z", now)!
        const stale = freshnessFromDate("2020-01-01T00:00:00Z", now)!
        expect(fresh).toBeGreaterThan(stale)
    })

    it("无效日期返回 undefined", () => {
        expect(freshnessFromDate("not-a-date")).toBeUndefined()
    })

    it("综合分对缺失字段给中性默认值", () => {
        expect(scoreEvidence({ id: "1", source: "web", content: "x", createdAt: 0 })).toBeCloseTo(0.5, 5)
    })
})

describe("归一化工具", () => {
    it("canonicalUrl 去掉跟踪参数与末尾斜杠", () => {
        expect(canonicalUrl("https://WWW.Example.com/a/b/?utm_campaign=x&id=1#frag"))
            .toBe("example.com/a/b?id=1")
    })

    it("contentHash 折叠全角标点", () => {
        expect(contentHash("你好，世界")).toBe(contentHash("你好,世界"))
    })

    it("normalizeTitle 去掉分隔符", () => {
        expect(normalizeTitle("Redis —— 部署说明")).toBe(normalizeTitle("Redis部署说明"))
    })
})
