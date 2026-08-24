import type {
    AgentEvidence,
    AgentObservation,
    AgentPlanStep,
    AgentRunStatus,
    AgentStopReason,
    AgentToolErrorCode,
    RoutingHint,
    TaskComplexity,
} from "./types"

/**
 * Agent 流式事件协议（§78/§162.2）。
 *
 * 前端只能靠这些结构化事件驱动 UI，禁止解析自然语言猜状态。
 * sequence 单调递增，同一 runId 的事件可重放恢复整个 Run 视图。
 */
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

export type AgentStreamEventPayloadMap = {
    agent_started: { goal: string; model: string; conversationId: string }
    complexity_detected: { complexity: TaskComplexity; routingHint?: RoutingHint; reason?: string }
    plan_created: { steps: AgentPlanStep[] }
    plan_updated: { steps: AgentPlanStep[]; changed?: string[] }
    skill_loaded: { skillId: string; name: string; description: string; toolIds: string[] }
    tool_started: { callId: string; toolId: string; namespace: string; title: string }
    tool_completed: {
        callId: string
        toolId: string
        namespace: string
        summary: string
        durationMs: number
        evidenceIds: string[]
    }
    tool_failed: {
        callId: string
        toolId: string
        namespace: string
        errorCode: AgentToolErrorCode
        /** 面向用户的安全文案，不含堆栈 */
        message: string
        durationMs: number
        willRetry: boolean
    }
    observation_created: { observation: PublicObservation }
    evidence_created: { evidence: PublicEvidence[] }
    delegation_started: { taskId: string; objective: string; depth: number }
    delegation_progress: { taskId: string; summary: string }
    delegation_completed: {
        taskId: string
        status: "completed" | "stopped"
        summary: string
        evidenceCount: number
        durationMs: number
    }
    delegation_failed: { taskId: string; message: string; durationMs: number }
    wiki_mention_targets: {
        targets: Array<{
            pageKey: string
            title: string
            aliases: string[]
            kind: string | null
            citationIndex: number | null
        }>
    }
    /**
     * 开始新的一段作答。
     * replace=true 表示整段重答（质量重写），前端应丢弃已流出的内容；
     * 缺省表示只是换段（工具调用打断），前端保留前文、另起一段。
     */
    final_answer_started: { replace?: boolean }
    final_answer_delta: { delta: string }
    final_answer_completed: { text: string }
    agent_completed: {
        status: AgentRunStatus
        stopReason?: AgentStopReason
        metrics: AgentRunMetrics
    }
    agent_stopped: { stopReason: AgentStopReason; message: string; metrics: AgentRunMetrics }
    agent_cancelled: { metrics: AgentRunMetrics }
    agent_error: { message: string; errorCode?: AgentToolErrorCode }
}

export type AgentRunMetrics = {
    durationMs: number
    toolCalls: number
    evidenceCount: number
    subAgentCount: number
    iterations: number
}

/** 对普通 UI 暴露的观察（§162.38：不含 raw args / 内部 prompt） */
export type PublicObservation = {
    id: string
    type: string
    source: string
    summary: string
    isError?: boolean
    createdAt: number
}

/** 对普通 UI 暴露的证据（§162.14） */
export type PublicEvidence = {
    id: string
    source: AgentEvidence["source"]
    title: string
    snippet?: string
    url?: string
    nodeKey?: string
    articleId?: string
    knowledgeBaseId?: string
    path?: string[]
    relevance?: number
}

export type AgentStreamEvent<T extends AgentStreamEventType = AgentStreamEventType> = {
    runId: string
    sequence: number
    type: T
    timestamp: number
    payload: AgentStreamEventPayloadMap[T]
}

export type AgentEventSink = (event: AgentStreamEvent) => void

/** 事件发射器：统一分配 sequence 与时间戳 */
export class AgentEventEmitter {
    private sequence = 0

    constructor(
        private readonly runId: string,
        private readonly sink?: AgentEventSink,
    ) {}

    emit<T extends AgentStreamEventType>(type: T, payload: AgentStreamEventPayloadMap[T]): AgentStreamEvent<T> {
        this.sequence += 1
        const event: AgentStreamEvent<T> = {
            runId: this.runId,
            sequence: this.sequence,
            type,
            timestamp: Date.now(),
            payload,
        }
        this.sink?.(event as AgentStreamEvent)
        return event
    }

    get lastSequence(): number {
        return this.sequence
    }
}

export function toPublicObservation(observation: AgentObservation): PublicObservation {
    return {
        id: observation.id,
        type: observation.type,
        source: observation.source,
        summary: observation.summary,
        ...(observation.isError ? { isError: true } : {}),
        createdAt: observation.createdAt,
    }
}

export function toPublicEvidence(evidence: AgentEvidence): PublicEvidence {
    const metadata = evidence.metadata ?? {}
    return {
        id: evidence.id,
        source: evidence.source,
        title: evidence.title ?? evidence.content.slice(0, 60),
        ...(evidence.content ? { snippet: evidence.content.slice(0, 280) } : {}),
        ...(evidence.url ? { url: evidence.url } : {}),
        ...(typeof metadata.nodeKey === "string" ? { nodeKey: metadata.nodeKey } : {}),
        ...(typeof metadata.articleId === "string" ? { articleId: metadata.articleId } : {}),
        ...(typeof metadata.knowledgeBaseId === "string"
            ? { knowledgeBaseId: metadata.knowledgeBaseId }
            : {}),
        ...(Array.isArray(metadata.path) ? { path: metadata.path as string[] } : {}),
        ...(evidence.relevance != null ? { relevance: evidence.relevance } : {}),
    }
}
