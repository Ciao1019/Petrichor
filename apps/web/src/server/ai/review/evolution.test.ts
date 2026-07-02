import { describe, expect, it } from "vitest"
import {
    buildEvolutionUserMessage,
    evolutionTopicLabel,
    formatBeijingMonth,
    hasEnoughEvolutionSpan,
    parseEvolutionResult,
    selectEvolutionTopic,
} from "./evolution"
import type { ReviewStats } from "./stats"

function makeStats(overrides: Partial<ReviewStats> = {}): ReviewStats {
    return {
        newArticles: 2,
        updatedArticles: 1,
        totalChars: 5000,
        knowledgeBaseCount: 1,
        topTags: [],
        topArticles: [],
        knowledgeBases: [],
        ...overrides,
    }
}

describe("selectEvolutionTopic", () => {
    it("优先选出现 2 次以上的高频标签", () => {
        const topic = selectEvolutionTopic(makeStats({
            topTags: [{ tag: "只出现一次", count: 1 }, { tag: "rust", count: 3 }],
            knowledgeBases: [{ id: "1", name: "技术笔记", articleCount: 5 }],
        }))
        expect(topic).toEqual({ kind: "tag", value: "rust" })
    })

    it("没有高频标签时回退到最活跃知识库", () => {
        const topic = selectEvolutionTopic(makeStats({
            topTags: [{ tag: "solo", count: 1 }],
            knowledgeBases: [{ id: "7", name: "读书笔记", articleCount: 4 }],
        }))
        expect(topic).toEqual({ kind: "kb", id: 7, name: "读书笔记" })
    })

    it("标签与知识库都不够活跃时返回 null", () => {
        const topic = selectEvolutionTopic(makeStats({
            topTags: [{ tag: "solo", count: 1 }],
            knowledgeBases: [{ id: "7", name: "零散", articleCount: 1 }],
        }))
        expect(topic).toBeNull()
    })
})

describe("hasEnoughEvolutionSpan", () => {
    const article = (iso: string) => ({ title: "t", summary: null, createdAt: new Date(iso) })

    it("至少 3 篇且跨 2 个月才成立", () => {
        expect(hasEnoughEvolutionSpan([
            article("2026-03-10T00:00:00Z"),
            article("2026-03-20T00:00:00Z"),
            article("2026-05-01T00:00:00Z"),
        ])).toBe(true)
    })

    it("篇数不足或集中在同一个月时不成立", () => {
        expect(hasEnoughEvolutionSpan([
            article("2026-03-10T00:00:00Z"),
            article("2026-05-01T00:00:00Z"),
        ])).toBe(false)
        expect(hasEnoughEvolutionSpan([
            article("2026-03-01T00:00:00Z"),
            article("2026-03-10T00:00:00Z"),
            article("2026-03-20T00:00:00Z"),
        ])).toBe(false)
    })

    it("月份按北京时间划分", () => {
        // UTC 3 月 31 日 20:00 = 北京时间 4 月 1 日 04:00
        expect(formatBeijingMonth(new Date("2026-03-31T20:00:00Z"))).toBe("2026-04")
    })
})

describe("parseEvolutionResult", () => {
    const valid = {
        topic: "rust",
        synthesis: "从语法学习走向工程实践，最终形成了自己的错误处理观。",
        entries: [
            { period: "2026-03", title: "入门", note: "关注所有权与生命周期的基本规则。" },
            { period: "2026-05", title: "实践修正", note: "推翻了「到处 clone」的做法，改用借用优先。" },
        ],
    }

    it("解析合法结果并保留条目顺序", () => {
        const result = parseEvolutionResult(JSON.stringify(valid))
        expect(result?.topic).toBe("rust")
        expect(result?.entries).toHaveLength(2)
        expect(result?.entries[0].period).toBe("2026-03")
    })

    it("剥掉代码块围栏", () => {
        const result = parseEvolutionResult("```json\n" + JSON.stringify(valid) + "\n```")
        expect(result?.topic).toBe("rust")
    })

    it("过滤 period 非法的条目", () => {
        const result = parseEvolutionResult(JSON.stringify({
            ...valid,
            entries: [...valid.entries, { period: "March", title: "x", note: "y" }],
        }))
        expect(result?.entries).toHaveLength(2)
    })

    it("条目不足 2 条或字段缺失时返回 null（模型明示无脉络也归于此）", () => {
        expect(parseEvolutionResult(JSON.stringify({ topic: "", synthesis: "", entries: [] }))).toBeNull()
        expect(parseEvolutionResult(JSON.stringify({ ...valid, entries: [valid.entries[0]] }))).toBeNull()
        expect(parseEvolutionResult("不是 JSON")).toBeNull()
    })
})

describe("buildEvolutionUserMessage", () => {
    it("按月份标注素材", () => {
        const message = buildEvolutionUserMessage({
            topicLabel: "rust",
            articles: [
                { title: "所有权入门", summary: "所有权与借用。", createdAt: new Date("2026-03-10T00:00:00Z") },
            ],
        })
        expect(message).toContain("主题：rust")
        expect(message).toContain("[2026-03] 所有权入门")
    })
})

describe("evolutionTopicLabel", () => {
    it("返回标签名或知识库名", () => {
        expect(evolutionTopicLabel({ kind: "tag", value: "rust" })).toBe("rust")
        expect(evolutionTopicLabel({ kind: "kb", id: 1, name: "读书笔记" })).toBe("读书笔记")
    })
})
