import { agentRunApi, type AgentRunDetailResponse } from "@/lib/api"
import { toolActivityGroup, toolActivityType } from "@/lib/agent/tool-ui"
import { useAgentRunsStore } from "./store"
import type { AgentRunViewModel } from "./types"

/**
 * 刷新恢复（§162.29/§162.30）。
 *
 * 依赖后端 Run API，而不是浏览器内存：刷新后 Plan、Sources、Answer、
 * 已完成活动与子任务摘要都能还原。
 */
export function toRunViewModel(response: AgentRunDetailResponse): AgentRunViewModel {
    return {
        id: response.id,
        status: response.status,
        ...(response.complexity ? { complexity: response.complexity } : {}),
        goal: response.goal,
        answer: response.answer,
        // 恢复态只有最终答案这一段
        answerSegmentStart: 0,
        plan: response.plan,
        loadedSkills: response.loadedSkills,
        activities: response.activities.map((activity) => ({
            id: activity.id,
            type: toolActivityType(activity.toolId),
            title: activity.summary || activity.toolId,
            description: activity.summary,
            status: activity.status,
            startedAt: activity.startedAt,
            completedAt: activity.startedAt + activity.durationMs,
            group: toolActivityGroup(activity.toolId),
            metadata: { toolId: activity.toolId, evidenceCount: activity.evidenceIds.length },
        })),
        subagents: response.subagents.map((item) => ({
            id: item.id,
            objective: item.objective,
            status: normalizeSubAgentStatus(item.status),
            ...(item.summary ? { summary: item.summary } : {}),
            evidenceCount: item.evidenceCount,
            ...(item.durationMs != null ? { completedAt: item.durationMs } : {}),
        })),
        evidence: response.evidence.map((item, index) => ({ ...item, citationIndex: index + 1 })),
        ...(response.stopMessage ? { stopMessage: response.stopMessage } : {}),
        metrics: response.metrics,
        startedAt: response.startedAt,
        ...(response.completedAt ? { completedAt: response.completedAt } : {}),
        // 恢复态不参与事件序号比较：后续新事件序号一定大于 0
        lastSequence: 0,
        hydrated: true,
    }
}

function normalizeSubAgentStatus(value: string): AgentRunViewModel["subagents"][number]["status"] {
    switch (value) {
        case "completed":
        case "failed":
        case "cancelled":
        case "running":
        case "pending":
            return value
        case "stopped":
            return "cancelled"
        default:
            return "completed"
    }
}

/** 拉取并注入 Run 视图；失败静默，聊天主流程不受影响 */
export async function hydrateAgentRun(runId: string): Promise<AgentRunViewModel | null> {
    const existing = useAgentRunsStore.getState().runs[runId]
    if (existing && existing.activities.length > 0) return existing
    try {
        const response = await agentRunApi.detail(runId)
        const run = toRunViewModel(response.data)
        useAgentRunsStore.getState().hydrate(run)
        return run
    } catch {
        return null
    }
}

/** 从历史消息里收集 agentRunId 并批量恢复 */
export async function hydrateRunsFromMessages(messages: unknown[]): Promise<void> {
    const runIds = new Set<string>()
    for (const message of messages) {
        const content = (message as { content?: unknown })?.content
        const runId = (content as { agentRunId?: unknown })?.agentRunId
        if (typeof runId === "string" && runId) runIds.add(runId)
    }
    const runs = await Promise.allSettled([...runIds].map((runId) => hydrateAgentRun(runId)))
    // 刷新时仍在执行的 Run：继续轮询直到终态（§162.30）
    for (const result of runs) {
        if (result.status !== "fulfilled" || !result.value) continue
        if (!TERMINAL_STATUS.has(result.value.status)) watchRunningRun(result.value.id)
    }
}

/**
 * 运行中 Run 的恢复（§162.30）。
 *
 * 后端目前不支持重新订阅事件流，所以刷新时若 Run 仍在执行，
 * 就按固定间隔轮询 Run 状态，直到进入终态或超时。
 * 期间 UI 显示的是后端真实状态，而不是假装还在流式输出。
 */
const RECONNECT_POLL_MS = 3_000
const RECONNECT_MAX_MS = 5 * 60_000

const TERMINAL_STATUS = new Set(["completed", "failed", "stopped", "cancelled"])

export function watchRunningRun(runId: string): () => void {
    let stopped = false
    const startedAt = Date.now()

    const tick = async () => {
        if (stopped) return
        const run = await hydrateRunLatest(runId)
        if (stopped) return
        if (run && TERMINAL_STATUS.has(run.status)) return
        if (Date.now() - startedAt > RECONNECT_MAX_MS) return
        setTimeout(() => { void tick() }, RECONNECT_POLL_MS)
    }

    void tick()
    return () => { stopped = true }
}

/** 与 hydrateAgentRun 的区别：强制拉最新状态，不因已有缓存而跳过 */
async function hydrateRunLatest(runId: string): Promise<AgentRunViewModel | null> {
    try {
        const response = await agentRunApi.detail(runId)
        const run = toRunViewModel(response.data)
        useAgentRunsStore.getState().hydrate(run)
        return run
    } catch {
        return null
    }
}
