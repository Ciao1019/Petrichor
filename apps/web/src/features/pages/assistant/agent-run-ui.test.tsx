// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentStreamEvent } from "@/features/agent-runs/types"
import { useAgentRunsStore } from "@/features/agent-runs/store"
import { AgentStreamingAnswer, AssistantPreparingStatus } from "./agent-run-ui"

// 消息在生成阶段只有 data part；正文更新必须由真实 Store 订阅触发。
vi.mock("@assistant-ui/react", () => ({
    makeAssistantDataUI: () => () => null,
    useAuiState: (selector: (state: unknown) => unknown) => selector({
        message: { parts: [{ type: "data", data: {
            runId: "run-1", sequence: 1, type: "agent_started", timestamp: 1, payload: {},
        } }] },
    }),
}))
vi.mock("@/components/agent/agent-run", () => ({ AgentRun: () => null }))
vi.mock("@/components/agent/agent-evidence", () => ({ AgentCitation: () => null }))
vi.mock("@/features/pages/knowledge/QaMarkdown", () => ({
    QaPreparing: ({ label }: { label: string }) => <div role="status">{label}</div>,
    QaStreamingMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}))

let sequence = 0
function emit(type: AgentStreamEvent["type"], payload: Record<string, unknown> = {}) {
    act(() => {
        useAgentRunsStore.getState().appendEvent({
            runId: "run-1", sequence: ++sequence, type, timestamp: sequence, payload,
        })
    })
}

function renderAnswer() {
    return render(<><AgentStreamingAnswer /><AssistantPreparingStatus /></>)
}

beforeEach(() => {
    sequence = 0
    useAgentRunsStore.getState().reset()
})
afterEach(() => {
    cleanup()
    useAgentRunsStore.getState().reset()
})

describe("助手首字等待提示", () => {
    it("Run 尚未创建时显示准备提示", () => {
        renderAnswer()
        expect(screen.getByRole("status").textContent).toBe("准备响应中")
    })

    it("直接回答的首字到达后立即隐藏提示，不等待标准 text part", () => {
        renderAnswer()
        emit("agent_started")
        emit("complexity_detected", { complexity: "direct" })
        emit("final_answer_started")
        expect(screen.getByRole("status").textContent).toBe("准备响应中")

        emit("final_answer_delta", { delta: "好，那就讲个故事。" })
        expect(screen.getByLabelText("回答生成中").textContent).toBe("好，那就讲个故事。")
        expect(screen.queryByRole("status")).toBeNull()

        emit("final_answer_completed", { text: "好，那就讲个故事。" })
        emit("agent_completed")
        expect(screen.getByLabelText("回答").textContent).toBe("好，那就讲个故事。")
        expect(screen.queryByRole("status")).toBeNull()
    })

    it("只有空白 delta 时继续等待首字", () => {
        renderAnswer()
        emit("agent_started")
        emit("final_answer_delta", { delta: " \n" })
        expect(screen.getByRole("status")).toBeTruthy()
        emit("final_answer_delta", { delta: "开始" })
        expect(screen.queryByRole("status")).toBeNull()
    })

    it("执行轨迹开始后让位给轨迹状态", () => {
        renderAnswer()
        emit("agent_started")
        emit("tool_started", { toolName: "lookup_knowledge", toolId: "lookup-1" })
        expect(screen.queryByRole("status")).toBeNull()
    })

    it("其他 Run 的正文不会隐藏当前消息的等待提示", () => {
        renderAnswer()
        emit("agent_started")
        act(() => {
            useAgentRunsStore.getState().appendEvent({
                runId: "another-run", sequence: 1, type: "final_answer_delta",
                timestamp: 1, payload: { delta: "另一条消息的回答" },
            })
        })
        expect(screen.getByRole("status")).toBeTruthy()
        expect(screen.queryByLabelText("回答生成中")).toBeNull()
    })
})
