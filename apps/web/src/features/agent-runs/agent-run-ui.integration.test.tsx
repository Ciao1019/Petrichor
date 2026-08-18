// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AgentRun } from "@/components/agent/agent-run"
import { agentRunReducer } from "./reducer"
import type { AgentRunViewModel, AgentStreamEvent } from "./types"

/**
 * 复杂 Agent Run 的前端集成测试（§162.50-22）。
 *
 * 从后端事件流出发，一路走 reducer → ViewModel → 组件渲染，
 * 验证的是「事件驱动 UI」这条链路，而不是某个组件的样式。
 */

let sequence = 0
function event(type: AgentStreamEvent["type"], payload: Record<string, unknown> = {}): AgentStreamEvent {
    sequence += 1
    return { runId: "run1", sequence, type, timestamp: 1_000 + sequence * 10, payload }
}

function drive(events: AgentStreamEvent[]): AgentRunViewModel {
    return events.reduce<AgentRunViewModel | null>(
        (state, item) => agentRunReducer(state, item),
        null,
    )!
}

/** 一个典型的复杂 Run：计划 + 知识检索 + 加载能力 + 并行子代理 + 证据 + 作答 */
function complexRunEvents(): AgentStreamEvent[] {
    return [
        event("agent_started", { goal: "对比我们 Redis 架构和官方最新方案" }),
        event("complexity_detected", { complexity: "complex" }),
        event("plan_created", {
            steps: [
                { id: "s1", goal: "了解内部 Redis 架构", status: "pending" },
                { id: "s2", goal: "查询官方方案", status: "pending" },
                { id: "s3", goal: "对比差异", status: "pending" },
            ],
        }),
        event("tool_started", { callId: "c1", toolId: "knowledge.search", title: "正在搜索知识库" }),
        event("tool_completed", { callId: "c1", toolId: "knowledge.search", summary: "找到 6 个节点", durationMs: 120, evidenceIds: [] }),
        event("tool_started", { callId: "c2", toolId: "knowledge.read", title: "正在阅读知识文档" }),
        event("tool_completed", { callId: "c2", toolId: "knowledge.read", summary: "已读取", durationMs: 90, evidenceIds: ["e1"] }),
        event("evidence_created", { evidence: [{ id: "e1", source: "knowledge", title: "Redis 架构设计" }] }),
        event("tool_started", { callId: "c3", toolId: "knowledge.read", title: "正在阅读知识文档" }),
        event("tool_completed", { callId: "c3", toolId: "knowledge.read", summary: "已读取", durationMs: 80, evidenceIds: ["e2"] }),
        event("evidence_created", { evidence: [{ id: "e2", source: "knowledge", title: "消息队列规范" }] }),
        event("skill_loaded", { skillId: "research", name: "外部研究", description: "外部检索", toolIds: ["research.search"] }),
        event("plan_updated", {
            steps: [
                { id: "s1", goal: "了解内部 Redis 架构", status: "completed" },
                { id: "s2", goal: "查询官方方案", status: "running" },
                { id: "s3", goal: "对比差异", status: "pending" },
                { id: "s4", goal: "检查版本兼容性", status: "pending" },
            ],
        }),
        event("delegation_started", { taskId: "t1", objective: "研究 Redis Streams", depth: 1 }),
        event("delegation_started", { taskId: "t2", objective: "研究 Redis 持久化", depth: 1 }),
        event("delegation_completed", { taskId: "t1", status: "completed", summary: "Streams 支持消费者组", evidenceCount: 3, durationMs: 800 }),
        event("evidence_created", {
            evidence: [{ id: "e3", source: "web", title: "Redis Streams Documentation", url: "https://redis.io/docs/streams" }],
        }),
    ]
}

beforeEach(() => {
    sequence = 0
})

afterEach(() => {
    cleanup()
})

describe("复杂 Agent Run 渲染", () => {
    it("运行中展示当前活动，并可停止", () => {
        const run = drive(complexRunEvents())
        render(<AgentRun run={run} onStop={() => {}} />)

        expect(screen.getByRole("region", { name: "Agent 执行状态" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "停止" })).toBeTruthy()
        expect(screen.getByText(/来源/)).toBeTruthy()
    })

    it("展开后同时展示计划、聚合活动与并行子代理", async () => {
        const run = drive(complexRunEvents())
        const { container } = render(<AgentRun run={run} />)

        const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement
        expect(toggle).toBeTruthy()
        toggle.click()

        const plan = await screen.findByRole("list", { name: "任务计划" })
        // 计划中途新增的步骤实时出现（§162.43）
        expect(within(plan).getByText("检查版本兼容性")).toBeTruthy()
        expect(within(plan).getByText("了解内部 Redis 架构")).toBeTruthy()

        const activities = screen.getByRole("list", { name: "执行步骤" })
        // 底层 3 次 knowledge.* 调用聚合成一条（§162.8）
        expect(within(activities).getByText("检索并阅读知识库")).toBeTruthy()
        expect(within(activities).getByText("检索 1 次，深读了 2 个相关章节")).toBeTruthy()

        const subagents = screen.getByRole("region", { name: "子任务" })
        expect(within(subagents).getByText("正在并行研究 2 个主题")).toBeTruthy()
        expect(within(subagents).getByText("研究 Redis Streams")).toBeTruthy()
        expect(within(subagents).getByText("研究 Redis 持久化")).toBeTruthy()
    })

    it("并行子代理状态各自独立，不会看起来像串行", async () => {
        const run = drive(complexRunEvents())
        const { container } = render(<AgentRun run={run} />)
        ;(container.querySelector("button[aria-expanded]") as HTMLButtonElement).click()

        const subagents = await screen.findByRole("region", { name: "子任务" })
        const items = within(subagents).getAllByRole("listitem")
        expect(items).toHaveLength(2)
        expect(within(items[0]).getByLabelText("已完成")).toBeTruthy()
        expect(within(items[1]).getByLabelText("进行中")).toBeTruthy()
    })

    it("完成后折叠为一行摘要，且不展示 token", () => {
        const run = drive([
            ...complexRunEvents(),
            event("final_answer_started"),
            event("final_answer_delta", { delta: "官方目前推荐 Streams [3]。" }),
            event("agent_completed", { status: "completed", metrics: { durationMs: 12_400, toolCalls: 8, evidenceCount: 3 } }),
        ])
        render(<AgentRun run={run} />)

        expect(screen.getByText(/已完成 · 8 个步骤 · 12.4s/)).toBeTruthy()
        expect(screen.queryByText(/token/i)).toBeNull()
        expect(screen.queryByRole("button", { name: "停止" })).toBeNull()
    })

    it("简单请求不渲染执行面板", () => {
        const run = drive([
            event("agent_started", { goal: "Redis 是什么" }),
            event("complexity_detected", { complexity: "direct" }),
            event("final_answer_delta", { delta: "Redis 是一个内存数据库。" }),
            event("agent_completed", { status: "completed", metrics: {} }),
        ])
        const { container } = render(<AgentRun run={run} />)
        expect(container.firstChild).toBeNull()
    })

    it("停止时展示用户可读文案，不出现内部策略名", () => {
        const run = drive([
            ...complexRunEvents(),
            event("agent_stopped", {
                stopReason: "loop_detected",
                message: "任务执行已停止，因为暂时无法获得更多有效信息。",
                metrics: { durationMs: 5_000, toolCalls: 6 },
            }),
        ])
        render(<AgentRun run={run} />)

        expect(screen.getByText(/暂时无法获得更多有效信息/)).toBeTruthy()
        expect(screen.queryByText(/loop_detected/)).toBeNull()
    })

    it("失败时提供重试入口", () => {
        const run = drive([
            ...complexRunEvents(),
            event("agent_error", { message: "执行过程中出现问题" }),
        ])
        let retried = false
        render(<AgentRun run={run} onRetry={() => { retried = true }} />)

        const button = screen.getByRole("button", { name: "重试" })
        button.click()
        expect(retried).toBe(true)
    })

    it("取消后所有未完成活动与子代理都置为已取消", async () => {
        const run = drive([...complexRunEvents(), event("agent_cancelled", { metrics: { durationMs: 3_000 } })])
        const { container } = render(<AgentRun run={run} />)
        ;(container.querySelector("button[aria-expanded]") as HTMLButtonElement).click()

        const subagents = await screen.findByRole("region", { name: "子任务" })
        expect(within(subagents).queryByLabelText("进行中")).toBeNull()
        expect(within(subagents).getAllByLabelText("已取消").length).toBeGreaterThan(0)
    })

    it("普通面板不展示原始工具参数与工具 ID", async () => {
        const run = drive(complexRunEvents())
        const { container } = render(<AgentRun run={run} />)
        ;(container.querySelector("button[aria-expanded]") as HTMLButtonElement).click()

        const text = container.textContent ?? ""
        expect(text).not.toContain("knowledge.search")
        expect(text).not.toContain("callId")
    })

    it("状态变化经 aria-live 播报，不只依赖颜色", () => {
        const run = drive(complexRunEvents())
        const { container } = render(<AgentRun run={run} />)
        expect(container.querySelector("[aria-live]")).toBeTruthy()
        // 折叠态的状态图标自带 aria-label，屏幕阅读器不依赖颜色也能理解
        expect(container.querySelector("[aria-label='执行中']")).toBeTruthy()
    })
})
