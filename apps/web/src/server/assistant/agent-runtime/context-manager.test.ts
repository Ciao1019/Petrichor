import { describe, expect, it } from "vitest"
import { z } from "zod"
import { resolveContextBudget } from "./config"
import { buildFinalAnswerContext, ContextManager, estimateTokens, renderPlan } from "./context-manager"
import { EvidenceStore } from "./evidence"
import { createObservation, ObservationStore } from "./observation"
import { AgentStateStore } from "./state"
import type { AgentToolDefinition } from "./types"

const tools: AgentToolDefinition[] = [{
    id: "knowledge.search",
    name: "search_knowledge",
    namespace: "knowledge",
    description: "搜索知识库",
    inputSchema: z.object({}),
    riskLevel: "low",
    sideEffect: false,
    execute: async () => ({}),
}]

function build(options?: { evidenceCount?: number; observationCount?: number; budgetTotal?: number }) {
    const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "我们的 Redis 怎么部署？" })
    const evidence = new EvidenceStore()
    const observations = new ObservationStore()

    for (let i = 0; i < (options?.evidenceCount ?? 0); i += 1) {
        evidence.add({
            source: "knowledge",
            title: `文档 ${i}`,
            content: `文档 ${i} 的正文：${"正文内容".repeat(300)}`,
            metadata: { nodeKey: `a1-${i}` },
            relevance: i / 100,
        })
    }
    for (let i = 0; i < (options?.observationCount ?? 0); i += 1) {
        observations.add(createObservation({
            type: "knowledge_search",
            source: "knowledge.search",
            summary: `第 ${i} 次检索找到若干节点`,
        }))
    }

    const manager = new ContextManager(resolveContextBudget(options?.budgetTotal ?? 100_000))
    const built = manager.build({
        state: state.current,
        observations,
        evidence,
        skillInstructions: [{ skillId: "knowledge", instructions: "KNOWLEDGE_PLAYBOOK" }],
        skillCatalog: [
            { id: "knowledge", name: "知识库", description: "检索知识库", instructions: "KNOWLEDGE_BODY", toolIds: [] },
            { id: "research", name: "研究", description: "外部检索", instructions: "RESEARCH_BODY", toolIds: [] },
        ],
        tools,
        recentMessages: [],
        remainingToolCalls: 3,
    })
    return { state, evidence, observations, manager, built }
}

describe("ContextManager", () => {
    it("包含目标、工具目录、已加载技能与状态", () => {
        const { built } = build()
        expect(built.instructions).toContain("我们的 Redis 怎么部署？")
        expect(built.instructions).toContain("knowledge.search")
        expect(built.instructions).toContain("KNOWLEDGE_PLAYBOOK")
        expect(built.instructions).toContain("剩余工具调用预算：3")
    })

    it("未加载技能只出现在目录里，不注入正文", () => {
        const { built } = build()
        expect(built.instructions).toContain("- research: 外部检索")
        expect(built.instructions).not.toContain("RESEARCH_BODY")
    })

    it("证据超预算时按 Top-N 截断并记录丢弃数量", () => {
        const { built } = build({ evidenceCount: 60, budgetTotal: 4_000 })
        expect(built.usedEvidence.length).toBeLessThan(60)
        expect(built.dropped.evidence).toBeGreaterThan(0)
        expect(built.tokens.evidence).toBeLessThanOrEqual(resolveContextBudget(4_000).evidence)
    })

    it("证据按相关度优先进入上下文", () => {
        const { built } = build({ evidenceCount: 30, budgetTotal: 6_000 })
        const scores = built.usedEvidence.map((item) => item.relevance ?? 0)
        expect(scores[0]).toBeGreaterThanOrEqual(scores.at(-1) ?? 0)
    })

    it("相关性重排不改变稳定引用编号", () => {
        const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "目标" })
        const evidence = new EvidenceStore()
        evidence.add({ source: "knowledge", title: "先到但较弱", content: "弱证据", relevance: 0.2 })
        evidence.add({ source: "knowledge", title: "后到但更强", content: "强证据", relevance: 0.9 })
        const built = new ContextManager().build({
            state: state.current,
            observations: new ObservationStore(),
            evidence,
            skillInstructions: [],
            skillCatalog: [],
            tools: [],
            recentMessages: [],
        })

        expect(built.instructions.indexOf("后到但更强")).toBeLessThan(built.instructions.indexOf("先到但较弱"))
        expect(built.instructions).toContain("[2] (knowledge) 后到但更强")
        expect(built.instructions).toContain("[1] (knowledge) 先到但较弱")
    })

    it("老观察被折叠而不是无限堆积", () => {
        const { built } = build({ observationCount: 200, budgetTotal: 4_000 })
        expect(built.dropped.observations).toBeGreaterThan(0)
        expect(built.instructions).toContain("已折叠")
    })

    it("对话裁剪保留最近消息", () => {
        const manager = new ContextManager(resolveContextBudget(1_000))
        const messages = Array.from({ length: 50 }, (_v, i) => ({ role: "user", content: `消息${i}`.repeat(20) }))
        const trimmed = manager.trimConversation(messages)
        expect(trimmed.length).toBeGreaterThan(0)
        expect(trimmed.length).toBeLessThan(messages.length)
        expect(trimmed.at(-1)).toEqual(messages.at(-1))
    })
})

describe("最终回答上下文", () => {
    it("只带目标、证据、错误观察与局限，不带原始结果", () => {
        const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "目标" })
        const evidence = new EvidenceStore()
        const item = evidence.add({ source: "web", title: "官方文档", content: "官方推荐 Streams", url: "https://redis.io/x" })
        const observations = new ObservationStore()
        observations.add(createObservation({
            type: "tool_error",
            source: "research.fetch",
            summary: "抓取超时",
            isError: true,
        }))

        const context = buildFinalAnswerContext({
            state: state.current,
            evidence: [item],
            observations,
            limitations: ["外部资料不完整"],
        })

        expect(context).toContain("目标")
        expect(context).toContain("[1] (web) 官方文档")
        expect(context).toContain("抓取超时")
        expect(context).toContain("外部资料不完整")
    })

    it("没有证据时明确提示如实说明", () => {
        const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "目标" })
        const context = buildFinalAnswerContext({
            state: state.current,
            evidence: [],
            observations: new ObservationStore(),
        })
        expect(context).toContain("没有获取到可引用的证据")
    })
})

describe("renderPlan / estimateTokens", () => {
    it("计划按状态渲染图标", () => {
        const text = renderPlan([
            { id: "1", goal: "查内部方案", status: "completed" },
            { id: "2", goal: "查官方资料", status: "running" },
            { id: "3", goal: "对比差异", status: "pending" },
        ])
        expect(text).toContain("✓ 查内部方案")
        expect(text).toContain("● 查官方资料")
        expect(text).toContain("○ 对比差异")
    })

    it("中文按更高密度估算 token", () => {
        expect(estimateTokens("中文中文中文")).toBeGreaterThan(estimateTokens("abcdef"))
        expect(estimateTokens("")).toBe(0)
    })
})
