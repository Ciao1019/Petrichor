import { describe, expect, it } from "vitest"

import {
    batchChunksByBudget,
    normalizeKnowledgeCategoryPath,
    normalizeKnowledgeRelations,
    normalizeRecommendedQuestions,
    parseMarkdownSections,
    splitMarkdownForKnowledgeBuild,
} from "./knowledge-build-workflow"

describe("article knowledge build workflow helpers", () => {
    it("所有标题层级都是候选边界，且记录完整标题路径", () => {
        const sections = parseMarkdownSections([
            "# 架构",
            "总体说明。",
            "## 存储",
            "存储说明。",
            "#### Redis",
            "缓存与队列。",
        ].join("\n"), "系统设计")

        expect(sections.map((section) => section.headingPath)).toEqual([
            ["架构"],
            ["架构", "存储"],
            ["架构", "存储", "Redis"],
        ])
    })

    it("整篇只用 h4-h6 的文档同样能切出结构边界", () => {
        // h1-h3 分级方案在这里会塌成一整段；层级无关的实现必须保住边界
        const sections = parseMarkdownSections([
            "#### 甲",
            "甲的内容。",
            "#### 乙",
            "乙的内容。",
            "##### 乙一",
            "乙一的内容。",
        ].join("\n"), "深层文档")

        expect(sections).toHaveLength(3)
        expect(sections.at(-1)?.headingPath).toEqual(["乙", "乙一"])
    })

    it("围栏内的 # 不算标题", () => {
        const sections = parseMarkdownSections([
            "# 正文",
            "```bash",
            "# 这是注释不是标题",
            "echo hi",
            "```",
            "结束。",
        ].join("\n"), "代码")

        expect(sections).toHaveLength(1)
    })

    it("短标题不独立成片，被合并进后续内容", () => {
        const { chunks } = splitMarkdownForKnowledgeBuild([
            "## 环境变量速查表",
            "### 必填",
            `必填说明。${"细节说明。".repeat(120)}`,
            "### 可选",
            `可选说明。${"补充说明。".repeat(120)}`,
        ].join("\n"), "配置")

        // "## 环境变量速查表" 正文为空，绝不能自己成为一个切片
        expect(chunks.every((chunk) => chunk.contentMd.trim() !== "## 环境变量速查表")).toBe(true)
        expect(chunks.every((chunk) => chunk.contentMd.length > 120)).toBe(true)
    })

    it("相邻小节贪心合并到目标尺寸，碎片不再入库", () => {
        const markdown = ["# 手册"]
        for (let index = 0; index < 12; index += 1) {
            markdown.push(`## 小节 ${index}`, "一句话说明。")
        }
        const { chunks } = splitMarkdownForKnowledgeBuild(markdown.join("\n"), "手册")

        expect(chunks.length).toBeLessThan(4)
        expect(chunks.map((chunk) => chunk.position)).toEqual(chunks.map((_, index) => index))
    })

    it("合并后由占绝对多数的一段命名，否则锚定到起始段", () => {
        const dominant = splitMarkdownForKnowledgeBuild([
            "# 部署",
            "## 步骤",
            `${"部署步骤说明。".repeat(100)}`,
            "## 备注",
            "小提示。",
        ].join("\n"), "手册").chunks
        expect(dominant[0].heading).toBe("步骤")

        const balanced = splitMarkdownForKnowledgeBuild([
            "# 架构",
            "## 存储",
            `${"存储说明。".repeat(30)}`,
            "## 缓存",
            `${"缓存说明。".repeat(30)}`,
        ].join("\n"), "系统").chunks
        // 顶层是 h1 时公共祖先才有值；这里必须给出起始段的具体路径而不是退化到 ["架构"]
        expect(balanced[0].headingPath).toEqual(["架构", "存储"])
    })

    it("过小的尾块向前合并", () => {
        const { chunks } = splitMarkdownForKnowledgeBuild([
            "# 文档",
            "## 主体",
            `${"主体内容。".repeat(260)}`,
            "## 收尾",
            "就这样。",
        ].join("\n"), "文档")

        expect(chunks.at(-1)?.contentMd).toContain("就这样。")
        expect(chunks.at(-1)!.contentMd.length).toBeGreaterThan(400)
    })

    it("超长章节按上限拆开并保留顺序", () => {
        const { chunks } = splitMarkdownForKnowledgeBuild(`## 长文\n\n${"内容段落。".repeat(300)}`, "长文", 300)

        expect(chunks.length).toBeGreaterThan(1)
        expect(chunks.map((chunk) => chunk.position)).toEqual(chunks.map((_, index) => index))
        expect(chunks.every((chunk) => chunk.heading === "长文")).toBe(true)
    })

    it("回退切分不把代码块拦腰截断", () => {
        const fence = ["```ts", ...Array.from({ length: 40 }, (_, i) => `const value${i} = ${i}`), "```"].join("\n")
        const { chunks } = splitMarkdownForKnowledgeBuild(
            `## 示例\n\n${"前置说明。".repeat(60)}\n\n${fence}\n\n${"后续说明。".repeat(60)}`,
            "示例",
            400,
        )

        // 每个切片里的围栏标记必须成对出现
        for (const chunk of chunks) {
            const fences = chunk.contentMd.split("\n").filter((line) => /^\s*(```|~~~)/.test(line))
            expect(fences.length % 2).toBe(0)
        }
    })

    it("触达切片上限时显式标记截断，不静默丢内容", () => {
        const markdown = Array.from({ length: 400 }, (_, index) => (
            `## 章节 ${index}\n\n${"这一节的内容说明。".repeat(60)}`
        )).join("\n\n")
        const { chunks, truncated } = splitMarkdownForKnowledgeBuild(markdown, "超长文档")

        expect(truncated).toBe(true)
        expect(chunks).toHaveLength(120)
    })

    it("问题生成按字符预算分批，不让单批塞进上万字", () => {
        const chunks = Array.from({ length: 9 }, () => ({ contentMd: "x".repeat(1_200) }))
        const batches = batchChunksByBudget(chunks, 4_000, 4)

        expect(batches.every((batch) => batch.length <= 4)).toBe(true)
        expect(batches.every((batch) => (
            batch.length === 1 || batch.reduce((sum, c) => sum + c.contentMd.length, 0) <= 4_000
        ))).toBe(true)
        expect(batches.flat()).toHaveLength(9)
    })

    it("单片超预算时自成一批", () => {
        const batches = batchChunksByBudget(
            [{ contentMd: "x".repeat(9_000) }, { contentMd: "y".repeat(100) }],
            4_000,
            4,
        )
        expect(batches.map((b) => b.length)).toEqual([1, 1])
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
