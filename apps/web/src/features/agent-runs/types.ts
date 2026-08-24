import type { AgentActivityType } from "@/lib/agent/tool-ui"
import type { WikiMentionTarget } from "@/lib/wiki-mentions"

/**
 * Agent Run 前端视图模型（§162.3/§162.4/§162.11/§162.14）。
 *
 * 所有状态都由后端结构化事件驱动，禁止靠解析自然语言猜测执行状态。
 */

export type AgentRunStatus =
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "stopped"
    | "cancelled"

export type TaskComplexity = "direct" | "simple" | "multi_step" | "complex"

export type AgentPlanStepStatus = "pending" | "running" | "completed" | "skipped" | "failed"

export type AgentPlanViewModel = {
    id: string
    goal: string
    status: AgentPlanStepStatus
    resultSummary?: string
}

export type AgentActivityStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export type AgentActivityViewModel = {
    id: string
    type: AgentActivityType
    title: string
    description?: string
    status: AgentActivityStatus
    startedAt?: number
    completedAt?: number
    /** 聚合分组 key：同组活动在 UI 上合并成一条（§162.8） */
    group: string
    metadata?: Record<string, unknown>
}

/** 聚合后展示用的活动组 */
export type AgentActivityGroupViewModel = {
    key: string
    type: AgentActivityType
    title: string
    detail?: string
    status: AgentActivityStatus
    count: number
    startedAt?: number
    completedAt?: number
}

export type SubAgentViewModel = {
    id: string
    objective: string
    status: "pending" | "running" | "completed" | "failed" | "cancelled"
    summary?: string
    evidenceCount?: number
    startedAt?: number
    completedAt?: number
}

export type EvidenceSource = "knowledge" | "web" | "graph" | "memory" | "subagent" | "tool"

export type EvidenceViewModel = {
    id: string
    source: EvidenceSource
    title: string
    snippet?: string
    url?: string
    nodeKey?: string
    articleId?: string
    knowledgeBaseId?: string
    path?: string[]
    relevance?: number
    /** 引用编号，用于答案中的 [n] 定位（§162.17） */
    citationIndex: number
}

export type AgentRunMetrics = {
    durationMs?: number
    toolCalls?: number
    evidenceCount?: number
    subAgentCount?: number
    iterations?: number
}

export type AgentRunViewModel = {
    id: string
    status: AgentRunStatus
    complexity?: TaskComplexity
    goal: string
    plan: AgentPlanViewModel[]
    activities: AgentActivityViewModel[]
    subagents: SubAgentViewModel[]
    evidence: EvidenceViewModel[]
    loadedSkills: string[]
    /** 实时答案全文：换段时旧段落保留，新内容接在其后 */
    answer: string
    /** 流式回答开始前下发的 Wiki 词典；只影响原位渲染，不改写 answer。 */
    wikiMentionTargets?: WikiMentionTarget[]
    /**
     * 当前作答段在 answer 中的起始下标。
     * final_answer_completed 只覆盖这一段，前面已归档的段落原样保留，
     * 否则结尾会把用户已经读到的内容整段换掉。
     */
    answerSegmentStart: number
    /** 面向用户的停止说明；不含内部策略名 */
    stopMessage?: string
    errorMessage?: string
    metrics?: AgentRunMetrics
    startedAt: number
    completedAt?: number
    /** 已处理的最大事件序号，用于幂等重放 */
    lastSequence: number
    /** 由后端 Run API 恢复而来，而非本次会话流式产生 */
    hydrated?: boolean
}

// ---------------------------------------------------------------------------
// 后端事件协议镜像（与 server/assistant/agent-runtime/events.ts 对齐）
// ---------------------------------------------------------------------------

export type AgentStreamEventType =
    | "agent_started"
    | "complexity_detected"
    | "plan_created"
    | "plan_updated"
    | "skill_loaded"
    | "tool_started"
    | "tool_completed"
    | "tool_failed"
    | "observation_created"
    | "evidence_created"
    | "delegation_started"
    | "delegation_progress"
    | "delegation_completed"
    | "delegation_failed"
    | "wiki_mention_targets"
    | "final_answer_started"
    | "final_answer_delta"
    | "final_answer_completed"
    | "agent_completed"
    | "agent_stopped"
    | "agent_cancelled"
    | "agent_error"

export type AgentStreamEvent = {
    runId: string
    sequence: number
    type: AgentStreamEventType
    timestamp: number
    payload: Record<string, unknown>
}

export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
    if (!value || typeof value !== "object") return false
    const record = value as Record<string, unknown>
    return typeof record.runId === "string"
        && typeof record.sequence === "number"
        && typeof record.type === "string"
}

/** 简单任务不展示执行面板（§162.1/§162.40） */
export function shouldShowExecutionPanel(run: AgentRunViewModel | null | undefined): boolean {
    if (!run) return false
    if (run.status === "failed" || run.status === "stopped" || run.status === "cancelled") return true
    if (run.complexity === "direct") return false
    if (run.plan.length > 0 || run.subagents.length > 0) return true
    return run.activities.length > 0
}
