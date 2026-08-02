import { describe, expect, it } from "vitest"

import type { SiteGraphDraft, SiteGraphDraftEdge, SiteGraphDraftNode } from "./types"
import { summarizeValidationReport, validateSiteGraphDraft } from "./validate"

function node(overrides: Partial<SiteGraphDraftNode> & { nodeKey: string }): SiteGraphDraftNode {
    return {
        parentKey: null,
        kind: "concept",
        name: overrides.nodeKey,
        summary: "摘要",
        route: null,
        articleId: null,
        attributes: [{ name: "类别", value: "示例" }],
        aliases: [],
        weight: 1,
        confidence: 90,
        source: "AGENT",
        ...overrides,
    }
}

function edge(overrides: Partial<SiteGraphDraftEdge> & { fromKey: string; toKey: string }): SiteGraphDraftEdge {
    return {
        relation: "关联",
        kind: "reference",
        attributes: [],
        weight: 1,
        directed: true,
        confidence: 90,
        source: "AGENT",
        ...overrides,
    }
}

function baseDraft(): SiteGraphDraft {
    return {
        nodes: [
            node({ nodeKey: "root", kind: "root", name: "全站星图", summary: "根" }),
            node({ nodeKey: "section-博客", kind: "section", name: "博客", parentKey: "root" }),
            node({ nodeKey: "article-1", kind: "article", name: "文章一", parentKey: "section-博客", route: "/p/a", articleId: "1" }),
            node({ nodeKey: "concept-x", name: "概念 X", parentKey: "section-博客" }),
        ],
        edges: [edge({ fromKey: "article-1", toKey: "concept-x", relation: "阐述" })],
    }
}

function codesOf(report: ReturnType<typeof validateSiteGraphDraft>) {
    return report.issues.map((issue) => issue.code)
}

describe("validateSiteGraphDraft", () => {
    it("结构完好的图谱校验通过并给出层级深度", () => {
        const report = validateSiteGraphDraft(baseDraft(), { publicArticleIds: new Set(["1"]) })
        expect(report.passed).toBe(true)
        expect(report.score).toBe(100)
        expect(report.maxDepth).toBe(2)
        expect(report.nodeCount).toBe(4)
        expect(report.edgeCount).toBe(1)
    })

    it("缺少根节点时报错", () => {
        const draft = baseDraft()
        draft.nodes = draft.nodes.filter((item) => item.nodeKey !== "root")
        const report = validateSiteGraphDraft(draft)
        expect(codesOf(report)).toContain("missing_root")
        expect(report.passed).toBe(false)
    })

    it("父节点不存在时报 broken_parent", () => {
        const draft = baseDraft()
        draft.nodes[1].parentKey = "ghost"
        const report = validateSiteGraphDraft(draft)
        expect(codesOf(report)).toContain("broken_parent")
        expect(report.passed).toBe(false)
    })

    it("父子关系成环时报 parent_cycle 且不会死循环", () => {
        const draft: SiteGraphDraft = {
            nodes: [
                node({ nodeKey: "root", kind: "root", name: "根" }),
                node({ nodeKey: "a", parentKey: "b" }),
                node({ nodeKey: "b", parentKey: "a" }),
            ],
            edges: [],
        }
        const report = validateSiteGraphDraft(draft)
        expect(codesOf(report)).toContain("parent_cycle")
        expect(report.passed).toBe(false)
    })

    it("文章未公开时报 private_article 警告，但不阻塞发布", () => {
        const report = validateSiteGraphDraft(baseDraft(), { publicArticleIds: new Set(["999"]) })
        const issue = report.issues.find((item) => item.code === "private_article")
        expect(issue?.target).toBe("article-1")
        // 前台读取路径已无条件按公开文章集过滤，这里只是运维提示，不再是唯一防线
        expect(issue?.severity).toBe("warning")
        expect(report.passed).toBe(true)
    })

    it("外链会被拦截", () => {
        const draft = baseDraft()
        draft.nodes[2].route = "https://evil.example.com"
        const report = validateSiteGraphDraft(draft, { publicArticleIds: new Set(["1"]) })
        expect(codesOf(report)).toContain("external_route")
    })

    it("关系端点不存在时报 broken_edge", () => {
        const draft = baseDraft()
        draft.edges.push(edge({ fromKey: "article-1", toKey: "ghost", relation: "幻觉" }))
        const report = validateSiteGraphDraft(draft, { publicArticleIds: new Set(["1"]) })
        expect(codesOf(report)).toContain("broken_edge")
    })

    it("孤立节点记为警告并计入 orphanCount", () => {
        const draft = baseDraft()
        draft.nodes.push(node({ nodeKey: "concept-孤儿", name: "孤儿" }))
        const report = validateSiteGraphDraft(draft, { publicArticleIds: new Set(["1"]) })
        expect(codesOf(report)).toContain("orphan_node")
        expect(report.orphanCount).toBe(1)
        // 只有警告不影响通过，但会扣分
        expect(report.passed).toBe(true)
        expect(report.score).toBe(95)
    })

    it("低置信度只记提示，不阻塞发布", () => {
        const draft = baseDraft()
        draft.nodes[3].confidence = 20
        const report = validateSiteGraphDraft(draft, { publicArticleIds: new Set(["1"]) })
        expect(codesOf(report)).toContain("low_confidence")
        expect(report.passed).toBe(true)
        expect(report.score).toBe(100)
    })

    it("重复节点键会被判定为错误", () => {
        const draft = baseDraft()
        draft.nodes.push(node({ nodeKey: "concept-x", name: "重复的 X" }))
        const report = validateSiteGraphDraft(draft, { publicArticleIds: new Set(["1"]) })
        expect(codesOf(report)).toContain("duplicate_key")
        expect(report.passed).toBe(false)
    })
})

describe("summarizeValidationReport", () => {
    it("按错误/警告数量给出不同结论", () => {
        const passed = validateSiteGraphDraft(baseDraft(), { publicArticleIds: new Set(["1"]) })
        expect(summarizeValidationReport(passed)).toContain("校验通过")

        const failing = baseDraft()
        failing.nodes[1].parentKey = "ghost"
        expect(summarizeValidationReport(validateSiteGraphDraft(failing))).toContain("校验未通过")
    })
})
