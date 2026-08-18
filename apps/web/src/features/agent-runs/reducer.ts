import {
    activityFromDelegation,
    activityFromSkillLoaded,
    activityFromToolStarted,
    activityPatchFromToolCompleted,
    activityPatchFromToolFailed,
} from "./activity-mapper"
import type {
    AgentActivityViewModel,
    AgentPlanViewModel,
    AgentRunViewModel,
    AgentStreamEvent,
    EvidenceViewModel,
    SubAgentViewModel,
} from "./types"

/**
 * Agent Run reducer（§162.5）。
 *
 * 纯函数：事件 → 新状态。要求幂等且可重放——同一 runId 的事件按 sequence
 * 重放必须得到同样的结果，因此刷新恢复与断线重连都走同一条路径。
 */

export function createEmptyRun(runId: string, goal = "", startedAt = Date.now()): AgentRunViewModel {
    return {
        id: runId,
        status: "starting",
        goal,
        plan: [],
        activities: [],
        subagents: [],
        evidence: [],
        loadedSkills: [],
        answer: "",
        startedAt,
        lastSequence: 0,
    }
}

export function agentRunReducer(
    state: AgentRunViewModel | null,
    event: AgentStreamEvent,
): AgentRunViewModel {
    const base = state && state.id === event.runId
        ? state
        : createEmptyRun(event.runId, "", event.timestamp)

    // 幂等：重复或乱序到达的旧事件直接忽略
    if (event.sequence <= base.lastSequence) return base

    const next = applyEvent(base, event)
    return { ...next, lastSequence: event.sequence }
}

export function replayEvents(runId: string, events: AgentStreamEvent[]): AgentRunViewModel {
    return [...events]
        .sort((a, b) => a.sequence - b.sequence)
        .reduce<AgentRunViewModel>(
            (state, event) => agentRunReducer(state, event),
            createEmptyRun(runId),
        )
}

function applyEvent(state: AgentRunViewModel, event: AgentStreamEvent): AgentRunViewModel {
    const payload = event.payload as Record<string, unknown>

    switch (event.type) {
        case "agent_started":
            return {
                ...state,
                status: "running",
                goal: String(payload.goal ?? state.goal),
                startedAt: event.timestamp,
            }

        case "complexity_detected":
            return { ...state, complexity: payload.complexity as AgentRunViewModel["complexity"] }

        case "plan_created":
        case "plan_updated":
            return { ...state, plan: toPlan(payload.steps) }

        case "skill_loaded": {
            const skillId = String(payload.skillId ?? "")
            return {
                ...state,
                loadedSkills: state.loadedSkills.includes(skillId)
                    ? state.loadedSkills
                    : [...state.loadedSkills, skillId],
                activities: upsertActivity(state.activities, activityFromSkillLoaded(event)),
            }
        }

        case "tool_started":
            return { ...state, activities: upsertActivity(state.activities, activityFromToolStarted(event)) }

        case "tool_completed":
            return { ...state, activities: patchActivity(state.activities, activityPatchFromToolCompleted(event)) }

        case "tool_failed":
            return { ...state, activities: patchActivity(state.activities, activityPatchFromToolFailed(event)) }

        case "evidence_created":
            return { ...state, evidence: appendEvidence(state.evidence, payload.evidence) }

        case "delegation_started": {
            const taskId = String(payload.taskId ?? "")
            const subagent: SubAgentViewModel = {
                id: taskId,
                objective: String(payload.objective ?? ""),
                status: "running",
                startedAt: event.timestamp,
            }
            return {
                ...state,
                subagents: upsertSubAgent(state.subagents, subagent),
                activities: upsertActivity(state.activities, activityFromDelegation(event)),
            }
        }

        case "delegation_progress":
            return {
                ...state,
                subagents: patchSubAgent(state.subagents, String(payload.taskId ?? ""), {
                    summary: String(payload.summary ?? ""),
                }),
            }

        case "delegation_completed":
            return {
                ...state,
                subagents: patchSubAgent(state.subagents, String(payload.taskId ?? ""), {
                    status: payload.status === "completed" ? "completed" : "cancelled",
                    summary: String(payload.summary ?? ""),
                    evidenceCount: Number(payload.evidenceCount ?? 0),
                    completedAt: event.timestamp,
                }),
                activities: patchActivity(state.activities, {
                    id: `task:${String(payload.taskId ?? "")}`,
                    status: "completed",
                    completedAt: event.timestamp,
                }),
            }

        case "delegation_failed":
            return {
                ...state,
                subagents: patchSubAgent(state.subagents, String(payload.taskId ?? ""), {
                    status: "failed",
                    summary: String(payload.message ?? ""),
                    completedAt: event.timestamp,
                }),
                activities: patchActivity(state.activities, {
                    id: `task:${String(payload.taskId ?? "")}`,
                    status: "failed",
                    completedAt: event.timestamp,
                }),
            }

        // 换段重答：清空已缓冲的答案，避免上一段的半截文字残留（见 chat-bridge）
        case "final_answer_started":
            return { ...state, answer: "" }

        case "final_answer_delta":
            return { ...state, answer: state.answer + String(payload.delta ?? "") }

        case "final_answer_completed":
            return { ...state, answer: String(payload.text ?? state.answer) }

        case "agent_completed":
            return {
                ...state,
                status: normalizeStatus(payload.status, state.status),
                metrics: payload.metrics as AgentRunViewModel["metrics"],
                completedAt: event.timestamp,
                activities: settleRunning(state.activities, event.timestamp),
            }

        case "agent_stopped":
            return {
                ...state,
                status: "stopped",
                stopMessage: String(payload.message ?? ""),
                metrics: payload.metrics as AgentRunViewModel["metrics"],
                completedAt: event.timestamp,
                activities: settleRunning(state.activities, event.timestamp),
            }

        case "agent_cancelled":
            return {
                ...state,
                status: "cancelled",
                metrics: payload.metrics as AgentRunViewModel["metrics"],
                completedAt: event.timestamp,
                activities: cancelRunning(state.activities, event.timestamp),
                subagents: state.subagents.map((item) =>
                    item.status === "running" ? { ...item, status: "cancelled" as const } : item,
                ),
            }

        case "agent_error":
            return {
                ...state,
                status: "failed",
                errorMessage: String(payload.message ?? "执行过程中出现问题"),
                completedAt: event.timestamp,
                activities: settleRunning(state.activities, event.timestamp),
            }

        // observation 只在 Debug 通道使用，普通 UI 不额外渲染
        case "observation_created":
        default:
            return state
    }
}

function normalizeStatus(value: unknown, fallback: AgentRunViewModel["status"]): AgentRunViewModel["status"] {
    switch (value) {
        case "completed":
        case "failed":
        case "stopped":
        case "cancelled":
        case "running":
            return value
        default:
            return fallback === "running" ? "completed" : fallback
    }
}

function toPlan(value: unknown): AgentPlanViewModel[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const record = item as Record<string, unknown>
        if (typeof record.id !== "string" || typeof record.goal !== "string") return []
        return [{
            id: record.id,
            goal: record.goal,
            status: (record.status as AgentPlanViewModel["status"]) ?? "pending",
            ...(typeof record.resultSummary === "string" ? { resultSummary: record.resultSummary } : {}),
        }]
    })
}

function upsertActivity(
    activities: AgentActivityViewModel[],
    activity: AgentActivityViewModel,
): AgentActivityViewModel[] {
    const index = activities.findIndex((item) => item.id === activity.id)
    if (index < 0) return [...activities, activity]
    const next = [...activities]
    next[index] = { ...next[index], ...activity }
    return next
}

function patchActivity(
    activities: AgentActivityViewModel[],
    patch: Partial<AgentActivityViewModel> & { id: string },
): AgentActivityViewModel[] {
    const index = activities.findIndex((item) => item.id === patch.id)
    if (index < 0) return activities
    const next = [...activities]
    next[index] = { ...next[index], ...patch }
    return next
}

function settleRunning(activities: AgentActivityViewModel[], now: number): AgentActivityViewModel[] {
    return activities.map((item) =>
        item.status === "running" || item.status === "pending"
            ? { ...item, status: "completed" as const, completedAt: now }
            : item,
    )
}

function cancelRunning(activities: AgentActivityViewModel[], now: number): AgentActivityViewModel[] {
    return activities.map((item) =>
        item.status === "running" || item.status === "pending"
            ? { ...item, status: "cancelled" as const, completedAt: now }
            : item,
    )
}

function upsertSubAgent(list: SubAgentViewModel[], item: SubAgentViewModel): SubAgentViewModel[] {
    const index = list.findIndex((existing) => existing.id === item.id)
    if (index < 0) return [...list, item]
    const next = [...list]
    next[index] = { ...next[index], ...item }
    return next
}

function patchSubAgent(
    list: SubAgentViewModel[],
    id: string,
    patch: Partial<SubAgentViewModel>,
): SubAgentViewModel[] {
    const index = list.findIndex((item) => item.id === id)
    if (index < 0) return list
    const next = [...list]
    next[index] = { ...next[index], ...patch }
    return next
}

/** 证据按到达顺序分配稳定的引用编号（§162.17） */
function appendEvidence(existing: EvidenceViewModel[], incoming: unknown): EvidenceViewModel[] {
    if (!Array.isArray(incoming)) return existing
    const known = new Set(existing.map((item) => item.id))
    let cursor = existing.length
    const added: EvidenceViewModel[] = []

    for (const item of incoming) {
        if (!item || typeof item !== "object") continue
        const record = item as Record<string, unknown>
        const id = typeof record.id === "string" ? record.id : ""
        if (!id || known.has(id)) continue
        known.add(id)
        cursor += 1
        added.push({
            id,
            source: (record.source as EvidenceViewModel["source"]) ?? "tool",
            title: typeof record.title === "string" ? record.title : "未命名来源",
            ...(typeof record.snippet === "string" ? { snippet: record.snippet } : {}),
            ...(typeof record.url === "string" ? { url: record.url } : {}),
            ...(typeof record.nodeKey === "string" ? { nodeKey: record.nodeKey } : {}),
            ...(typeof record.articleId === "string" ? { articleId: record.articleId } : {}),
            ...(typeof record.knowledgeBaseId === "string" ? { knowledgeBaseId: record.knowledgeBaseId } : {}),
            ...(Array.isArray(record.path) ? { path: record.path as string[] } : {}),
            ...(typeof record.relevance === "number" ? { relevance: record.relevance } : {}),
            citationIndex: cursor,
        })
    }

    return added.length > 0 ? [...existing, ...added] : existing
}
