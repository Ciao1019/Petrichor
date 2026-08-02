import { describe, expect, it } from "vitest"

import {
    SiteGraphEntityRegistry,
    nameSimilarity,
    normalizeEntityName,
    type EntityRegistryEntry,
} from "./entity-registry"
import { alignNodesWithRegistry } from "./extract-agent"
import type { SiteGraphDraftNode } from "./types"

function node(overrides: Partial<SiteGraphDraftNode> & { nodeKey: string; name: string }): SiteGraphDraftNode {
    return {
        parentKey: null,
        kind: "concept",
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

function entry(overrides: Partial<EntityRegistryEntry> & { canonicalKey: string; name: string }): EntityRegistryEntry {
    return { aliases: [], kind: "concept", weight: 1, ...overrides }
}

describe("normalizeEntityName", () => {
    it("折叠大小写、空白、标点与全角", () => {
        expect(normalizeEntityName("Vector Search")).toBe("vectorsearch")
        expect(normalizeEntityName("vector-search")).toBe("vectorsearch")
        expect(normalizeEntityName("ＶＥＣＴＯＲ　ＳＥＡＲＣＨ")).toBe("vectorsearch")
        expect(normalizeEntityName("向量 检索")).toBe("向量检索")
        expect(normalizeEntityName("RAG（检索增强）")).toBe("rag检索增强")
    })
})

describe("nameSimilarity", () => {
    it("完全相同为 1，无关字符串接近 0", () => {
        expect(nameSimilarity("向量检索", "向量检索")).toBe(1)
        expect(nameSimilarity("向量检索", "用户鉴权")).toBe(0)
    })

    it("相近名称给出较高分数", () => {
        expect(nameSimilarity("向量检索", "向量搜索")).toBeGreaterThan(0.3)
        expect(nameSimilarity("postgresql", "postgres")).toBeGreaterThan(0.7)
    })
})

describe("SiteGraphEntityRegistry.resolve", () => {
    it("规范化后名称一致时复用已有规范键（自动合并）", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "concept-向量检索", name: "向量检索" })])
        const result = registry.resolve(node({ nodeKey: "concept-vector-search", name: "向量 检索" }))
        expect(result.match).toBe("name")
        expect(result.canonicalKey).toBe("concept-向量检索")
        expect(result.candidate).toBeNull()
    })

    it("命中已有实体的别名时也自动合并", () => {
        const registry = new SiteGraphEntityRegistry([
            entry({ canonicalKey: "concept-向量检索", name: "向量检索", aliases: ["vector search"] }),
        ])
        const result = registry.resolve(node({ nodeKey: "concept-vs", name: "Vector Search" }))
        expect(result.match).toBe("name")
        expect(result.canonicalKey).toBe("concept-向量检索")
    })

    it("新节点自带的别名命中已有实体时同样合并", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "concept-rag", name: "RAG" })])
        const result = registry.resolve(node({
            nodeKey: "concept-检索增强生成",
            name: "检索增强生成",
            aliases: ["rag"],
        }))
        expect(result.match).toBe("alias")
        expect(result.canonicalKey).toBe("concept-rag")
    })

    it("只是名称相近时不合并，产出待确认候选", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "concept-向量检索", name: "向量检索" })])
        const result = registry.resolve(node({ nodeKey: "concept-向量搜索", name: "向量搜索" }))
        expect(result.match).toBe("none")
        expect(result.canonicalKey).toBe("concept-向量搜索")
        expect(result.candidate?.targetKey).toBe("concept-向量检索")
        expect(registry.mergeCandidates()).toHaveLength(1)
    })

    it("互为子串时产出 name_contains 候选", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "entity-postgres", name: "PostgreSQL", kind: "entity" })])
        const result = registry.resolve(node({ nodeKey: "entity-pg-vector", name: "PostgreSQL 向量扩展", kind: "entity" }))
        expect(result.candidate?.reason).toBe("name_contains")
        expect(result.candidate?.score).toBeGreaterThanOrEqual(70)
    })

    it("毫不相干的名称既不合并也不产候选", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "concept-向量检索", name: "向量检索" })])
        const result = registry.resolve(node({ nodeKey: "concept-用户鉴权", name: "用户鉴权" }))
        expect(result.match).toBe("none")
        expect(result.candidate).toBeNull()
        expect(registry.mergeCandidates()).toHaveLength(0)
    })

    it("短名不触发子串候选，避免噪声", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "entity-ai", name: "AI", kind: "entity" })])
        const result = registry.resolve(node({ nodeKey: "entity-ai-agent", name: "AI Agent", kind: "entity" }))
        expect(result.candidate?.reason).not.toBe("name_contains")
    })
})

describe("SiteGraphEntityRegistry.topEntries", () => {
    it("按权重降序截断，用于回喂提示词", () => {
        const registry = new SiteGraphEntityRegistry([
            entry({ canonicalKey: "a", name: "A", weight: 1 }),
            entry({ canonicalKey: "b", name: "B", weight: 9 }),
            entry({ canonicalKey: "c", name: "C", weight: 5 }),
        ])
        expect(registry.topEntries(2).map((item) => item.canonicalKey)).toEqual(["b", "c"])
    })
})

describe("alignNodesWithRegistry", () => {
    it("把同义节点改写成规范键，并把原名降级为别名", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "concept-向量检索", name: "向量检索" })])
        const result = alignNodesWithRegistry(
            [node({ nodeKey: "concept-vector-search", name: "向量 检索" })],
            registry,
        )
        expect(result.autoAlignedCount).toBe(1)
        expect(result.nodes[0].nodeKey).toBe("concept-向量检索")
        expect(result.nodes[0].aliases).toContain("向量 检索")
        expect(result.keyRewrites.get("concept-vector-search")).toBe("concept-向量检索")
    })

    it("未命中时保留原键并注册进表，供后续批次对齐", () => {
        const registry = new SiteGraphEntityRegistry()
        const result = alignNodesWithRegistry([node({ nodeKey: "concept-rag", name: "RAG", aliases: ["检索增强"] })], registry)
        expect(result.autoAlignedCount).toBe(0)
        expect(result.nodes[0].nodeKey).toBe("concept-rag")

        // 下一批用别名写法应能对齐到同一个键
        const second = registry.resolve(node({ nodeKey: "concept-检索增强", name: "检索增强" }))
        expect(second.canonicalKey).toBe("concept-rag")
    })

    it("结构骨架节点不参与实体对齐", () => {
        const registry = new SiteGraphEntityRegistry([entry({ canonicalKey: "concept-文章", name: "文章" })])
        const result = alignNodesWithRegistry(
            [node({ nodeKey: "article-1", name: "文章", kind: "article" })],
            registry,
        )
        expect(result.nodes[0].nodeKey).toBe("article-1")
        expect(result.autoAlignedCount).toBe(0)
    })
})
