import { newId } from "./ids"
import type {
    AgentDelegationTrace,
    AgentLatencyMetrics,
    AgentSkillTrace,
    AgentTokenUsage,
    AgentTrace,
    AgentToolTrace,
    AgentTraceEvent,
    AgentTraceEventType,
    AgentStopReason,
    RoutingHint,
    TaskComplexity,
} from "./types"

/**
 * Run 级 Trace 收集（§64~§67）。
 *
 * 原则：
 * - 原始 Tool Result 只落在这里，不进 LLM Context；
 * - 敏感字段在写入前脱敏（§67），不为了 debug 存 secret/token；
 * - 事件按 sequence 有序，可持久化后按 runId/conversationId/userId/时间/工具/stopReason 查询。
 */
export class TraceCollector {
    private readonly events: AgentTraceEvent[] = []
    private readonly toolCalls: AgentToolTrace[] = []
    private readonly skillLoads: AgentSkillTrace[] = []
    private readonly delegations: AgentDelegationTrace[] = []
    private readonly evidenceIds = new Set<string>()
    private readonly latency: AgentLatencyMetrics = {}
    private tokenUsage: AgentTokenUsage = { input: 0, output: 0, total: 0 }
    private sequence = 0
    private stopReason?: AgentStopReason
    private completedAt?: number
    private routingHint?: RoutingHint
    private complexity: TaskComplexity = "simple"

    constructor(
        readonly runId: string,
        readonly conversationId: string,
        readonly userId: string,
        readonly model: string,
        readonly startedAt: number = Date.now(),
    ) {}

    event(type: AgentTraceEventType, payload: Record<string, unknown>): AgentTraceEvent {
        this.sequence += 1
        const event: AgentTraceEvent = {
            id: newId("tev"),
            runId: this.runId,
            sequence: this.sequence,
            type,
            payload: redact(payload) as Record<string, unknown>,
            createdAt: Date.now(),
        }
        this.events.push(event)
        return event
    }

    setRoutingHint(hint: RoutingHint): void {
        this.routingHint = hint
        this.event("routing_hint", { ...hint })
    }

    setComplexity(complexity: TaskComplexity, reason?: string): void {
        this.complexity = complexity
        this.event("complexity_decided", { complexity, ...(reason ? { reason } : {}) })
    }

    recordToolCall(trace: AgentToolTrace): void {
        // 入参同样要脱敏：工具参数里可能带 key/token，只脱输出等于没脱（§67）
        this.toolCalls.push({
            ...trace,
            input: redact(trace.input),
            rawOutput: redact(trace.rawOutput),
        })
        for (const id of trace.evidenceIds) this.evidenceIds.add(id)
        this.latency.toolMs = (this.latency.toolMs ?? 0) + trace.durationMs
    }

    recordSkillLoad(trace: AgentSkillTrace): void {
        this.skillLoads.push(trace)
        this.event("skill_loaded", { ...trace })
    }

    recordDelegation(trace: AgentDelegationTrace): void {
        this.delegations.push(trace)
        this.latency.subAgentMs = (this.latency.subAgentMs ?? 0) + trace.durationMs
        this.event("delegation_completed", { ...trace })
    }

    recordEvidenceIds(ids: string[]): void {
        for (const id of ids) this.evidenceIds.add(id)
    }

    /** 检索诊断（§94）：query / 各路召回命中 / 融合与 rerank 排名 */
    recordRetrievalDiagnostics(payload: Record<string, unknown>): void {
        this.event("retrieval_diagnostics", payload)
        if (typeof payload.retrievalMs === "number") {
            this.latency.retrievalMs = (this.latency.retrievalMs ?? 0) + payload.retrievalMs
        }
        if (typeof payload.rerankMs === "number") {
            this.latency.rerankMs = (this.latency.rerankMs ?? 0) + payload.rerankMs
        }
    }

    addTokenUsage(usage: Partial<AgentTokenUsage>): void {
        const input = usage.input ?? 0
        const output = usage.output ?? 0
        this.tokenUsage = {
            input: this.tokenUsage.input + input,
            output: this.tokenUsage.output + output,
            total: this.tokenUsage.total + (usage.total ?? input + output),
        }
    }

    addLlmLatency(ms: number): void {
        this.latency.llmMs = (this.latency.llmMs ?? 0) + ms
    }

    markFirstToken(now = Date.now()): void {
        if (this.latency.ttftMs == null) this.latency.ttftMs = now - this.startedAt
    }

    finish(stopReason: AgentStopReason | undefined, now = Date.now()): void {
        this.stopReason = stopReason
        this.completedAt = now
        this.latency.totalMs = now - this.startedAt
        this.event("stop", { ...(stopReason ? { stopReason } : {}), totalMs: this.latency.totalMs })
    }

    build(): AgentTrace {
        return {
            runId: this.runId,
            conversationId: this.conversationId,
            userId: this.userId,
            model: this.model,
            ...(this.routingHint ? { routingHint: this.routingHint } : {}),
            complexity: this.complexity,
            steps: this.events,
            toolCalls: this.toolCalls,
            skillLoads: this.skillLoads,
            delegations: this.delegations,
            evidenceIds: [...this.evidenceIds],
            tokenUsage: this.tokenUsage,
            latency: this.latency,
            startedAt: this.startedAt,
            ...(this.completedAt ? { completedAt: this.completedAt } : {}),
            ...(this.latency.totalMs != null ? { totalLatencyMs: this.latency.totalMs } : {}),
            ...(this.stopReason ? { stopReason: this.stopReason } : {}),
        }
    }
}

const SENSITIVE_KEY = /(password|secret|token|api[-_]?key|credential|authorization|cookie|access[-_]?key|private[-_]?key)/i
const MAX_STRING = 4_000
const MAX_ARRAY = 50
const MAX_DEPTH = 6

/**
 * Trace 脱敏与体积裁剪（§67）。
 * 敏感 key 一律打码；长文本与长数组截断，避免 trace 表被单条撑爆。
 */
export function redact(value: unknown, depth = 0): unknown {
    if (value == null) return value
    if (depth >= MAX_DEPTH) return "[truncated:depth]"
    if (typeof value === "string") {
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value
    }
    if (typeof value === "number" || typeof value === "boolean") return value
    if (Array.isArray(value)) {
        const head = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1))
        return value.length > MAX_ARRAY ? [...head, `[+${value.length - MAX_ARRAY} more]`] : head
    }
    if (typeof value !== "object") return String(value)

    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) {
            out[key] = "[redacted]"
            continue
        }
        out[key] = redact(item, depth + 1)
    }
    return out
}
