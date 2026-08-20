import { describe, expect, it } from "vitest"

import {
    normalizeKnowledgeCategoryPath,
    normalizeKnowledgeRelations,
    normalizeRecommendedQuestions,
    splitMarkdownForKnowledgeBuild,
} from "./knowledge-build-workflow"

describe("article knowledge build workflow helpers", () => {
    it("按 Markdown 标题生成平铺切片，不生成父子目录节点", () => {
        const chunks = splitMarkdownForKnowledgeBuild([
            "# 架构",
            "",
            "总体说明。",
            "",
            "## Redis",
            "",
            "缓存与队列。",
            "",
            "## PostgreSQL",
            "",
            "持久化数据。",
        ].join("\n"), "系统设计")

        expect(chunks.map((chunk) => chunk.chunkKey)).toEqual(["chunk-001", "chunk-002", "chunk-003"])
        expect(chunks.map((chunk) => chunk.heading)).toEqual(["架构", "Redis", "PostgreSQL"])
        expect(chunks.every((chunk) => !("parentKey" in chunk))).toBe(true)
    })

    it("超长章节按上限拆开并保留顺序", () => {
        const chunks = splitMarkdownForKnowledgeBuild(`## 长文\n\n${"内容段落。".repeat(300)}`, "长文", 300)

        expect(chunks.length).toBeGreaterThan(1)
        expect(chunks.map((chunk) => chunk.position)).toEqual(chunks.map((_, index) => index))
        expect(chunks.every((chunk) => chunk.heading === "长文")).toBe(true)
    })

    it("每个切片始终规范化为三个推荐问题", () => {
        expect(normalizeRecommendedQuestions(["问题 A", "问题 B", "问题 C", "问题 D"], "缓存")).toEqual([
            "问题 A",
            "问题 B",
            "问题 C",
        ])
        expect(normalizeRecommendedQuestions([], "缓存")).toHaveLength(3)
    })

    it("分类路径最多两级并移除实体/概念类型目录", () => {
        expect(normalizeKnowledgeCategoryPath("实体 / 技术 / 数据库 / PostgreSQL")).toEqual(["技术", "数据库"])
        expect(normalizeKnowledgeCategoryPath(["概念", "工程实践"])).toEqual(["工程实践"])
    })

    it("只保留候选页面之间有方向的知识关系", () => {
        const relations = normalizeKnowledgeRelations([
            {
                fromPageKey: "entity/Mole",
                toPageKey: "concept/智能卸载",
                relationType: "提供",
                description: "Mole 提供智能卸载能力。",
            },
            {
                fromPageKey: "entity/Mole",
                toPageKey: "concept/智能卸载",
                relationType: "提供",
                description: "重复项",
            },
            {
                fromPageKey: "entity/Mole",
                toPageKey: "concept/未抽取页面",
                relationType: "关联",
            },
        ], new Set(["entity-mole", "concept-智能卸载"]))

        expect(relations).toEqual([{
            fromPageKey: "entity-mole",
            toPageKey: "concept-智能卸载",
            relationType: "提供",
            description: "Mole 提供智能卸载能力。",
        }])
    })
})
