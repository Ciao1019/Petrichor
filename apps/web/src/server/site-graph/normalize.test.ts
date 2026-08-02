import { describe, expect, it } from "vitest"

import {
    SITE_GRAPH_LIMITS,
    consolidateDraft,
    extractJsonObjectText,
    mergeDraftEdges,
    mergeDraftNodes,
    normalizeAliases,
    normalizeAttributes,
    normalizeDraftEdge,
    normalizeDraftNode,
    normalizeNodeKey,
    normalizeRoute,
} from "./normalize"
import type { SiteGraphDraftEdge, SiteGraphDraftNode } from "./types"

function makeNode(overrides: Partial<SiteGraphDraftNode> = {}): SiteGraphDraftNode {
    return {
        nodeKey: "concept-a",
        parentKey: null,
        kind: "concept",
        name: "概念 A",
        summary: "",
        route: null,
        articleId: null,
        attributes: [],
        aliases: [],
        weight: 1,
        confidence: 80,
        source: "AGENT",
        ...overrides,
    }
}

function makeEdge(overrides: Partial<SiteGraphDraftEdge> = {}): SiteGraphDraftEdge {
    return {
        fromKey: "concept-a",
        toKey: "concept-b",
        relation: "关联",
        kind: "reference",
        attributes: [],
        weight: 1,
        directed: true,
        confidence: 80,
        source: "AGENT",
        ...overrides,
    }
}

describe("normalizeNodeKey", () => {
    it("保留中文并把空白和斜杠折叠成连字符", () => {
        expect(normalizeNodeKey("  Vector Search / 向量检索 ")).toBe("vector-search-向量检索")
    })

    it("全部字符被过滤时用哈希兜底，保证稳定且唯一", () => {
        const first = normalizeNodeKey("!!!")
        const second = normalizeNodeKey("!!!")
        expect(first).toMatch(/^node-[0-9a-f]{12}$/)
        expect(first).toBe(second)
        expect(normalizeNodeKey("???")).not.toBe(first)
    })
})

describe("normalizeRoute", () => {
    it("只接受站内路径", () => {
        expect(normalizeRoute("/p/abc")).toBe("/p/abc")
        expect(normalizeRoute("https://evil.example.com")).toBeNull()
        expect(normalizeRoute("//evil.example.com")).toBeNull()
        expect(normalizeRoute("  ")).toBeNull()
    })
})

describe("normalizeAttributes", () => {
    it("去掉空值、按属性名去重并限量", () => {
        const attributes = normalizeAttributes([
            { name: "类别", value: "检索" },
            { name: "类别", value: "重复应被丢弃" },
            { name: "", value: "无名" },
            { name: "空值", value: "  " },
            ...Array.from({ length: 20 }, (_, index) => ({ name: `属性${index}`, value: "值" })),
        ])
        expect(attributes[0]).toEqual({ name: "类别", value: "检索" })
        expect(attributes.filter((item) => item.name === "类别")).toHaveLength(1)
        expect(attributes.length).toBeLessThanOrEqual(SITE_GRAPH_LIMITS.attributesPerItem)
    })
})

describe("normalizeAliases", () => {
    it("忽略大小写去重并限量", () => {
        expect(normalizeAliases(["RAG", "rag", " 检索增强 ", ""])).toEqual(["RAG", "检索增强"])
    })
})

describe("normalizeDraftNode", () => {
    it("名称为空时视为无效节点", () => {
        expect(normalizeDraftNode({ nodeKey: "x" })).toBeNull()
    })

    it("父节点等于自身时清空父引用", () => {
        const node = normalizeDraftNode({ nodeKey: "concept-a", name: "A", parentKey: "concept-a" })
        expect(node?.parentKey).toBeNull()
    })

    it("非法 articleId 被丢弃", () => {
        expect(normalizeDraftNode({ name: "A", articleId: "abc" })?.articleId).toBeNull()
        expect(normalizeDraftNode({ name: "A", articleId: "12" })?.articleId).toBe("12")
    })
})

describe("normalizeDraftEdge", () => {
    it("缺少端点或关系名时返回 null", () => {
        expect(normalizeDraftEdge({ from: "a", relation: "关联" })).toBeNull()
        expect(normalizeDraftEdge({ from: "a", to: "b" })).toBeNull()
    })

    it("自环被丢弃", () => {
        expect(normalizeDraftEdge({ from: "a", to: "a", relation: "关联" })).toBeNull()
    })
})

describe("mergeDraftNodes", () => {
    it("同键节点合并属性与别名，权重累加、置信度取高", () => {
        const merged = mergeDraftNodes([
            makeNode({ attributes: [{ name: "类别", value: "检索" }], aliases: ["RAG"], weight: 2, confidence: 60 }),
            makeNode({ attributes: [{ name: "场景", value: "问答" }], aliases: ["rag", "检索增强"], weight: 3, confidence: 90 }),
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0].attributes).toHaveLength(2)
        expect(merged[0].aliases).toEqual(["RAG", "检索增强"])
        expect(merged[0].weight).toBe(5)
        expect(merged[0].confidence).toBe(90)
    })

    it("结构骨架类型优先于后来的概念类型", () => {
        const merged = mergeDraftNodes([
            makeNode({ nodeKey: "article-1", kind: "article", route: "/p/a", articleId: "1" }),
            makeNode({ nodeKey: "article-1", kind: "concept" }),
        ])
        expect(merged[0].kind).toBe("article")
        expect(merged[0].route).toBe("/p/a")
    })
})

describe("mergeDraftEdges", () => {
    it("同三元组合并且权重累加", () => {
        const merged = mergeDraftEdges([makeEdge({ weight: 1 }), makeEdge({ weight: 4, confidence: 95 })])
        expect(merged).toHaveLength(1)
        expect(merged[0].weight).toBe(5)
        expect(merged[0].confidence).toBe(95)
    })

    it("关系名不同时保留为两条", () => {
        expect(mergeDraftEdges([makeEdge({ relation: "依赖" }), makeEdge({ relation: "对比" })])).toHaveLength(2)
    })
})

describe("consolidateDraft", () => {
    it("丢弃指向不存在节点的关系，并清空悬空的父引用", () => {
        const draft = consolidateDraft({
            nodes: [
                makeNode({ nodeKey: "concept-a", parentKey: "missing-parent" }),
                makeNode({ nodeKey: "concept-b" }),
            ],
            edges: [
                makeEdge({ fromKey: "concept-a", toKey: "concept-b" }),
                makeEdge({ fromKey: "concept-a", toKey: "ghost", relation: "幻觉" }),
            ],
        })
        expect(draft.nodes.find((node) => node.nodeKey === "concept-a")?.parentKey).toBeNull()
        expect(draft.edges).toHaveLength(1)
        expect(draft.edges[0].toKey).toBe("concept-b")
    })
})

describe("extractJsonObjectText", () => {
    it("能从 Markdown 代码块和多余文字里截出 JSON", () => {
        expect(extractJsonObjectText("```json\n{\"a\":1}\n```")).toBe('{"a":1}')
        expect(extractJsonObjectText("好的，结果如下：{\"a\":1} 完毕")).toBe('{"a":1}')
        expect(extractJsonObjectText("没有 JSON")).toBeNull()
    })
})
