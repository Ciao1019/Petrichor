import { beforeEach, describe, expect, it } from "vitest"
import { aggregateActivities, currentActivityLabel } from "./activity-mapper"
import { agentRunReducer, createEmptyRun, replayEvents } from "./reducer"
import { selectCompletionSummary, selectEvidenceBySource } from "./selectors"
import { shouldShowExecutionPanel, type AgentStreamEvent } from "./types"

let sequence = 0
function event(type: AgentStreamEvent["type"], payload: Record<string, unknown> = {}, runId = "run1"): AgentStreamEvent {
    sequence += 1
    return { runId, sequence, type, timestamp: 1_000 + sequence, payload }
}

function reduce(events: AgentStreamEvent[]) {
    return events.reduce<ReturnType<typeof createEmptyRun> | null>(
        (state, item) => agentRunReducer(state, item),
        null,
    )!
}

beforeEach(() => {
    sequence = 0
})

describe("agentRunReducer", () => {
    it("从 agent_started 建立运行态", () => {
        const run = reduce([event("agent_started", { goal: "Redis 怎么部署" })])
        expect(run.status).toBe("running")
        expect(run.goal).toBe("Redis 怎么部署")
    })

    it("工具事件生成活动并在完成时更新状态", () => {
        const run = reduce([
            event("agent_started", { goal: "g" }),
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "正在搜索知识库" }),
            event("tool_completed", { callId: "c1", toolId: "knowledge.search", summary: "找到 6 个节点", durationMs: 120, evidenceIds: [] }),
        ])
        expect(run.activities).toHaveLength(1)
        expect(run.activities[0].status).toBe("completed")
        expect(run.activities[0].description).toBe("找到 6 个节点")
        expect(run.activities[0].type).toBe("knowledge_search")
    })

    it("失败且将重试的工具展示为「正在尝试其它来源」而不是报错", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "research.fetch", title: "正在阅读外部来源" }),
            event("tool_failed", { callId: "c1", toolId: "research.fetch", message: "该来源响应超时", willRetry: true }),
        ])
        expect(run.activities[0].status).toBe("running")
        expect(run.activities[0].title).toBe("正在尝试其它来源")
    })

    it("计划更新会实时替换步骤", () => {
        const run = reduce([
            event("plan_created", { steps: [{ id: "s1", goal: "查内部方案", status: "completed" }] }),
            event("plan_updated", {
                steps: [
                    { id: "s1", goal: "查内部方案", status: "completed" },
                    { id: "s2", goal: "查官方资料", status: "running" },
                ],
            }),
        ])
        expect(run.plan).toHaveLength(2)
        expect(run.plan[1].status).toBe("running")
    })

    it("证据按到达顺序分配稳定引用编号且不重复", () => {
        const run = reduce([
            event("evidence_created", { evidence: [{ id: "e1", source: "knowledge", title: "内部文档" }] }),
            event("evidence_created", {
                evidence: [
                    { id: "e1", source: "knowledge", title: "内部文档" },
                    { id: "e2", source: "web", title: "官方文档", url: "https://redis.io" },
                ],
            }),
        ])
        expect(run.evidence).toHaveLength(2)
        expect(run.evidence.map((item) => item.citationIndex)).toEqual([1, 2])
    })

    it("子代理独立更新状态，支持并行展示", () => {
        const run = reduce([
            event("delegation_started", { taskId: "t1", objective: "研究 OpenAI", depth: 1 }),
            event("delegation_started", { taskId: "t2", objective: "研究 Anthropic", depth: 1 }),
            event("delegation_completed", { taskId: "t1", status: "completed", summary: "完成", evidenceCount: 6, durationMs: 100 }),
        ])
        expect(run.subagents).toHaveLength(2)
        expect(run.subagents[0].status).toBe("completed")
        expect(run.subagents[0].evidenceCount).toBe(6)
        expect(run.subagents[1].status).toBe("running")
    })

    it("final_answer_started 会重置答案缓冲，避免换段残留", () => {
        const run = reduce([
            event("final_answer_started"),
            event("final_answer_delta", { delta: "半截答案" }),
            event("final_answer_started"),
            event("final_answer_delta", { delta: "正式答案" }),
        ])
        expect(run.answer).toBe("正式答案")
    })

    it("停止时给出用户可读文案，不暴露内部策略名", () => {
        const run = reduce([
            event("agent_started", { goal: "g" }),
            event("agent_stopped", {
                stopReason: "loop_detected",
                message: "任务执行已停止，因为暂时无法获得更多有效信息。",
                metrics: { durationMs: 1_000, toolCalls: 3 },
            }),
        ])
        expect(run.status).toBe("stopped")
        expect(run.stopMessage).not.toContain("loop")
    })

    it("取消时未完成的活动与子代理一并置为 cancelled", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "正在搜索知识库" }),
            event("delegation_started", { taskId: "t1", objective: "研究", depth: 1 }),
            event("agent_cancelled", { metrics: { durationMs: 10 } }),
        ])
        expect(run.status).toBe("cancelled")
        expect(run.activities.every((item) => item.status === "cancelled")).toBe(true)
        expect(run.subagents[0].status).toBe("cancelled")
    })

    it("完成时把仍在运行的活动收尾", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "x" }),
            event("agent_completed", { status: "completed", metrics: { durationMs: 2_000, toolCalls: 1 } }),
        ])
        expect(run.status).toBe("completed")
        expect(run.activities[0].status).toBe("completed")
    })

    it("重复事件幂等，乱序旧事件被忽略", () => {
        const started = event("agent_started", { goal: "g" })
        const delta = event("final_answer_delta", { delta: "abc" })
        let run = agentRunReducer(null, started)
        run = agentRunReducer(run, delta)
        run = agentRunReducer(run, delta)
        run = agentRunReducer(run, started)
        expect(run.answer).toBe("abc")
    })

    it("按 sequence 重放得到同样结果", () => {
        const events = [
            event("agent_started", { goal: "g" }),
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "x" }),
            event("tool_completed", { callId: "c1", toolId: "knowledge.search", summary: "ok", durationMs: 1, evidenceIds: [] }),
            event("final_answer_delta", { delta: "答案" }),
        ]
        const sequential = reduce(events)
        const shuffled = replayEvents("run1", [...events].reverse())
        expect(shuffled.answer).toBe(sequential.answer)
        expect(shuffled.activities).toHaveLength(sequential.activities.length)
    })
})

describe("活动聚合", () => {
    it("同域多次调用合并成一条并给出数量说明", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "搜索" }),
            event("tool_completed", { callId: "c1", toolId: "knowledge.search", summary: "ok", durationMs: 1, evidenceIds: [] }),
            event("tool_started", { callId: "c2", toolId: "knowledge.read", title: "阅读" }),
            event("tool_completed", { callId: "c2", toolId: "knowledge.read", summary: "ok", durationMs: 1, evidenceIds: ["e1"] }),
            event("tool_started", { callId: "c3", toolId: "knowledge.read", title: "阅读" }),
            event("tool_completed", { callId: "c3", toolId: "knowledge.read", summary: "ok", durationMs: 1, evidenceIds: ["e2"] }),
        ])
        const groups = aggregateActivities(run.activities)
        expect(groups).toHaveLength(1)
        expect(groups[0].title).toBe("检索并阅读知识库")
        expect(groups[0].detail).toBe("检索 1 次，深读了 2 个相关章节")
    })

    it("搜索动作不会被误算成已阅读章节", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "搜索" }),
            event("tool_completed", { callId: "c1", toolId: "knowledge.search", summary: "ok", durationMs: 1, evidenceIds: [] }),
            event("tool_started", { callId: "c2", toolId: "knowledge.read", title: "阅读" }),
            event("tool_completed", { callId: "c2", toolId: "knowledge.read", summary: "ok", durationMs: 1, evidenceIds: ["e1"] }),
        ])

        expect(aggregateActivities(run.activities)[0].detail).toBe("检索 1 次，深读了 1 个相关章节")
    })

    it("不同域不会被合并", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "搜索" }),
            event("tool_started", { callId: "c2", toolId: "research.search", title: "外部搜索" }),
        ])
        expect(aggregateActivities(run.activities)).toHaveLength(2)
    })

    it("组内有进行中的活动时整组仍是运行中", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "搜索" }),
            event("tool_completed", { callId: "c1", toolId: "knowledge.search", summary: "ok", durationMs: 1, evidenceIds: [] }),
            event("tool_started", { callId: "c2", toolId: "knowledge.read", title: "阅读" }),
        ])
        expect(aggregateActivities(run.activities)[0].status).toBe("running")
    })

    it("运行中标签取最近一条进行中的活动", () => {
        const run = reduce([
            event("tool_started", { callId: "c1", toolId: "research.search", title: "正在搜索外部资料" }),
        ])
        expect(currentActivityLabel(run.activities)).toBe("正在搜索外部资料…")
    })
})

describe("选择器", () => {
    it("按内部/外部拆分来源", () => {
        const run = reduce([
            event("evidence_created", {
                evidence: [
                    { id: "e1", source: "knowledge", title: "内部" },
                    { id: "e2", source: "web", title: "外部", url: "https://x.com" },
                ],
            }),
        ])
        const grouped = selectEvidenceBySource(run)
        expect(grouped.internal).toHaveLength(1)
        expect(grouped.external).toHaveLength(1)
    })

    it("完成摘要只含步数与耗时，不含 token", () => {
        const run = reduce([
            event("agent_completed", { status: "completed", metrics: { durationMs: 12_400, toolCalls: 8 } }),
        ])
        const summary = selectCompletionSummary(run)
        expect(summary).toContain("8 个步骤")
        expect(summary).toContain("12.4s")
        expect(summary).not.toMatch(/token/i)
    })
})

describe("执行面板可见性", () => {
    it("直答请求不展示执行面板", () => {
        const run = reduce([
            event("agent_started", { goal: "1+1" }),
            event("complexity_detected", { complexity: "direct" }),
            event("agent_completed", { status: "completed", metrics: {} }),
        ])
        expect(shouldShowExecutionPanel(run)).toBe(false)
    })

    it("有工具活动的请求展示执行面板", () => {
        const run = reduce([
            event("complexity_detected", { complexity: "multi_step" }),
            event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "x" }),
        ])
        expect(shouldShowExecutionPanel(run)).toBe(true)
    })
})
