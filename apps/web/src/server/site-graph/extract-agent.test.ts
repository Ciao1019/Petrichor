import { describe, expect, it } from "vitest"

import {
    SITE_GRAPH_CONCEPT_SECTION_KEY,
    SITE_GRAPH_TAG_SECTION_KEY,
    buildExtractionUserMessage,
    buildSkeletonDraft,
    chunkArticles,
    parseExtractionResult,
} from "./extract-agent"
import type { SiteGraphArticleInput } from "./types"

function article(overrides: Partial<SiteGraphArticleInput> & { articleId: string }): SiteGraphArticleInput {
    return {
        title: `文章 ${overrides.articleId}`,
        route: `/p/code-${overrides.articleId}`,
        excerpt: "摘要",
        tags: [],
        contentMd: "正文内容",
        updatedAt: "2026-08-01T10:00:00.000Z",
        knowledgeBaseName: "技术笔记",
        ...overrides,
    }
}

describe("chunkArticles", () => {
    it("按批次切分且不丢文章", () => {
        const articles = Array.from({ length: 7 }, (_, index) => article({ articleId: String(index + 1) }))
        const batches = chunkArticles(articles, 3)
        expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1])
        expect(batches.flat()).toHaveLength(7)
    })
})

describe("buildSkeletonDraft", () => {
    it("生成 root → 分类 → 文章 的邻接结构", () => {
        const draft = buildSkeletonDraft([
            article({ articleId: "1" }),
            article({ articleId: "2", knowledgeBaseName: "读书笔记" }),
        ])
        const root = draft.nodes.find((node) => node.nodeKey === "root")
        expect(root?.kind).toBe("root")
        expect(root?.parentKey).toBeNull()

        const articleNode = draft.nodes.find((node) => node.nodeKey === "article-1")
        expect(articleNode?.kind).toBe("article")
        expect(articleNode?.route).toBe("/p/code-1")
        expect(articleNode?.articleId).toBe("1")

        const sectionKey = articleNode?.parentKey
        const section = draft.nodes.find((node) => node.nodeKey === sectionKey)
        expect(section?.kind).toBe("section")
        expect(section?.parentKey).toBe("root")
        // 两个不同知识库应生成两个分类节点
        expect(draft.nodes.filter((node) => node.kind === "section" && node.name !== "概念")).toHaveLength(2)
    })

    it("有标签时生成标签节点和「标注」关系", () => {
        const draft = buildSkeletonDraft([article({ articleId: "1", tags: ["RAG", "检索"] })])
        const tagNodes = draft.nodes.filter((node) => node.kind === "tag")
        expect(tagNodes).toHaveLength(2)
        expect(tagNodes.every((node) => node.parentKey === SITE_GRAPH_TAG_SECTION_KEY)).toBe(true)
        expect(draft.nodes.some((node) => node.nodeKey === SITE_GRAPH_TAG_SECTION_KEY)).toBe(true)
        expect(draft.edges.filter((item) => item.relation === "标注")).toHaveLength(2)
    })

    it("没有标签时不生成标签分类", () => {
        const draft = buildSkeletonDraft([article({ articleId: "1" })])
        expect(draft.nodes.some((node) => node.nodeKey === SITE_GRAPH_TAG_SECTION_KEY)).toBe(false)
    })

    it("文章节点带上分类与更新时间属性", () => {
        const draft = buildSkeletonDraft([article({ articleId: "1", tags: ["RAG"] })])
        const attributes = draft.nodes.find((node) => node.nodeKey === "article-1")?.attributes ?? []
        expect(attributes).toContainEqual({ name: "分类", value: "技术笔记" })
        expect(attributes).toContainEqual({ name: "更新时间", value: "2026-08-01" })
        expect(attributes).toContainEqual({ name: "标签", value: "RAG" })
    })
})

describe("buildExtractionUserMessage", () => {
    it("把可引用的文章节点键写进提示词", () => {
        const message = buildExtractionUserMessage([article({ articleId: "42" })])
        expect(message).toContain("article-42")
        expect(message).toContain("文章 42")
    })
})

describe("parseExtractionResult", () => {
    const context = { articleKeys: new Set(["article-1"]) }

    it("解析节点与关系，并把概念挂到「概念」分类下", () => {
        const raw = JSON.stringify({
            nodes: [{
                nodeKey: "concept-向量检索",
                name: "向量检索",
                kind: "concept",
                summary: "用向量相似度做召回",
                aliases: ["vector search"],
                attributes: [{ name: "类别", value: "检索技术" }],
                confidence: 88,
            }],
            edges: [{ fromKey: "article-1", toKey: "concept-向量检索", relation: "阐述", kind: "reference", confidence: 90 }],
        })
        const result = parseExtractionResult(raw, context)
        expect(result.nodes).toHaveLength(1)
        expect(result.nodes[0].parentKey).toBe(SITE_GRAPH_CONCEPT_SECTION_KEY)
        expect(result.nodes[0].attributes).toEqual([{ name: "类别", value: "检索技术" }])
        expect(result.nodes[0].source).toBe("AGENT")
        expect(result.edges).toHaveLength(1)
        expect(result.warnings).toHaveLength(0)
    })

    it("丢弃指向未知节点的关系并给出提示", () => {
        const raw = JSON.stringify({
            nodes: [],
            edges: [{ fromKey: "article-1", toKey: "concept-不存在", relation: "阐述" }],
        })
        const result = parseExtractionResult(raw, context)
        expect(result.edges).toHaveLength(0)
        expect(result.warnings[0]).toContain("丢弃 1 条")
    })

    it("忽略模型回写的文章/分类节点", () => {
        const raw = JSON.stringify({
            nodes: [
                { nodeKey: "article-1", name: "文章一", kind: "article" },
                { nodeKey: "section-x", name: "分类", kind: "section" },
            ],
            edges: [],
        })
        expect(parseExtractionResult(raw, context).nodes).toHaveLength(0)
    })

    it("模型输出不是 JSON 时整批跳过而不是抛错", () => {
        const result = parseExtractionResult("抱歉，我无法完成", context)
        expect(result.nodes).toHaveLength(0)
        expect(result.edges).toHaveLength(0)
        expect(result.warnings[0]).toContain("未返回合法 JSON")
    })

    it("兼容被 Markdown 代码块包裹的输出", () => {
        const raw = "```json\n" + JSON.stringify({
            nodes: [{ nodeKey: "entity-pgvector", name: "pgvector", kind: "entity" }],
            edges: [],
        }) + "\n```"
        expect(parseExtractionResult(raw, context).nodes[0].kind).toBe("entity")
    })
})
