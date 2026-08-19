"use client"

import { create } from "zustand"
import { agentRunReducer, createEmptyRun, replayEvents } from "./reducer"
import { traceAnswerStream } from "./stream-debug"
import { isAgentStreamEvent, type AgentRunViewModel, type AgentStreamEvent } from "./types"

/**
 * Agent Run Store（§162.6）。
 *
 * 复用项目现有的 zustand。事件是唯一写入口：
 * append → reducer → ViewModel → Renderer，组件不直接改状态。
 */

type AgentRunsState = {
    runs: Record<string, AgentRunViewModel>
    /** 当前正在运行的 runId（用于停止按钮等全局操作） */
    activeRunId: string | null

    appendEvent: (event: AgentStreamEvent) => void
    appendUnknown: (value: unknown) => void
    replay: (runId: string, events: AgentStreamEvent[]) => void
    hydrate: (run: AgentRunViewModel) => void
    cancelRun: (runId: string) => void
    reset: (runId?: string) => void
}

const TERMINAL: Array<AgentRunViewModel["status"]> = ["completed", "failed", "stopped", "cancelled"]

export const useAgentRunsStore = create<AgentRunsState>((set) => ({
    runs: {},
    activeRunId: null,

    appendEvent: (event) => set((state) => {
        const prev = state.runs[event.runId] ?? null
        const next = agentRunReducer(prev, event)
        traceAnswerStream(prev, next, event)
        const isTerminal = TERMINAL.includes(next.status)
        return {
            runs: { ...state.runs, [event.runId]: next },
            activeRunId: isTerminal
                ? (state.activeRunId === event.runId ? null : state.activeRunId)
                : event.runId,
        }
    }),

    appendUnknown: (value) => {
        if (!isAgentStreamEvent(value)) return
        useAgentRunsStore.getState().appendEvent(value)
    },

    replay: (runId, events) => set((state) => ({
        runs: { ...state.runs, [runId]: replayEvents(runId, events) },
    })),

    /** 刷新恢复：用后端 Run 视图直接灌入（§162.29） */
    hydrate: (run) => set((state) => ({
        runs: { ...state.runs, [run.id]: run },
        activeRunId: TERMINAL.includes(run.status) ? state.activeRunId : run.id,
    })),

    cancelRun: (runId) => set((state) => {
        const run = state.runs[runId]
        if (!run) return state
        return {
            runs: {
                ...state.runs,
                [runId]: {
                    ...run,
                    status: "cancelled",
                    completedAt: Date.now(),
                    activities: run.activities.map((item) =>
                        item.status === "running" ? { ...item, status: "cancelled" as const } : item,
                    ),
                    subagents: run.subagents.map((item) =>
                        item.status === "running" ? { ...item, status: "cancelled" as const } : item,
                    ),
                },
            },
            activeRunId: state.activeRunId === runId ? null : state.activeRunId,
        }
    }),

    reset: (runId) => set((state) => {
        if (!runId) return { runs: {}, activeRunId: null }
        const { [runId]: _removed, ...rest } = state.runs
        return { runs: rest, activeRunId: state.activeRunId === runId ? null : state.activeRunId }
    }),
}))

/**
 * 待重试的 runId（§162.24）。
 * 用模块级变量而不是 store 字段：它只在「点击重试 → 下一次请求发出」之间存活一瞬，
 * 放进 store 会让无关组件跟着重渲染。
 */
let pendingRetryRunId: string | null = null

export function markRetry(runId: string): void {
    pendingRetryRunId = runId
}

export function consumePendingRetryRunId(): string | null {
    const value = pendingRetryRunId
    pendingRetryRunId = null
    return value
}

export function ensureRun(runId: string, goal?: string): AgentRunViewModel {
    const existing = useAgentRunsStore.getState().runs[runId]
    if (existing) return existing
    const run = createEmptyRun(runId, goal)
    useAgentRunsStore.setState((state) => ({ runs: { ...state.runs, [runId]: run } }))
    return run
}
