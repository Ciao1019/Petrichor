import { and, asc, desc, eq } from "drizzle-orm"
import { createLogger, toLogError } from "@/lib/logger"
import { getDb } from "@/server/db/client"
import {
    agentEvidence,
    agentRuns,
    agentSubtasks,
    agentTraceEvents,
} from "@/server/db/schema"
import type { AgentRunEval } from "./eval"
import { citationIndicesForEvidence } from "./evidence"
import { toPublicEvidence, type PublicEvidence } from "./events"
import type { AgentRunMetrics } from "./events"
import type {
    AgentEvidence,
    AgentPlanStep,
    AgentState,
    AgentTrace,
    RoutingHint,
    TaskComplexity,
} from "./types"

const log = createLogger("agent-runtime-store")

/**
 * Agent Run 持久化（§66/§142~§146）。
 *
 * 落库口径：
 * - Run 头：可按 runKey / conversationId / userId / 时间 / stopReason 查询；
 * - Trace 事件：已在 TraceCollector 内脱敏与截断，这里只做搬运；
 * - Evidence：供刷新恢复与引用定位；
 * - SubTask：供并行子代理 UI 恢复。
 *
 * 所有写入都是 best-effort：落库失败不能让正在进行的对话失败（fail-open），
 * 但必须结构化 log（§139）。
 */

export type PersistRunInput = {
    runKey: string
    conversationId: string
    threadId?: number | null
    userId: number
    model: string
    goal: string
    complexity: TaskComplexity
    retryOfRunKey?: string | null
}

/** 迁移未执行时的可执行提示，避免只报一句「Failed query」让人无从下手 */
const MISSING_TABLE_HINT = "Agent Runtime 相关表不存在，请先执行 docs/migrations/2026-08-18-agent-runtime-v2.sql"

function logStoreError(scope: string, error: unknown, context: Record<string, unknown>): void {
    // drizzle 抛出的 Error.message 只有 "Failed query: ..."，真正原因在 cause 上（postgres.js 的 PostgresError）
    const cause = error instanceof Error ? error.cause : undefined
    const causeRecord = cause && typeof cause === "object" ? cause as Record<string, unknown> : null
    const code = typeof causeRecord?.code === "string" ? causeRecord.code : undefined
    const detail = causeRecord?.message ?? causeRecord?.detail

    log.error({
        err: toLogError(error),
        scope,
        ...(code ? { code } : {}),
        ...(detail ? { cause: String(detail) } : {}),
        // 42P01 = undefined_table，明确指向未执行的迁移
        ...(code === "42P01" ? { hint: MISSING_TABLE_HINT } : {}),
        ...context,
    }, "Agent Runtime 持久化失败，继续当前对话")
}

export async function createAgentRunRecord(input: PersistRunInput): Promise<void> {
    try {
        await getDb().insert(agentRuns).values({
            runKey: input.runKey,
            conversationId: input.conversationId,
            threadId: input.threadId ?? null,
            userId: input.userId,
            model: input.model,
            goal: input.goal.slice(0, 4_000),
            complexity: input.complexity,
            status: "running",
            retryOfRunKey: input.retryOfRunKey ?? null,
        })
    } catch (error) {
        logStoreError("createRun", error, { runKey: input.runKey })
    }
}

export async function finishAgentRunRecord(input: {
    runKey: string
    state: AgentState
    trace: AgentTrace
    answer: string
    evaluation?: AgentRunEval
}): Promise<void> {
    const { state, trace } = input
    try {
        await getDb().update(agentRuns).set({
            status: state.status,
            stopReason: state.stopReason ?? null,
            answer: input.answer.slice(0, 100_000),
            complexity: state.complexity,
            routingHintJson: trace.routingHint ? JSON.stringify(trace.routingHint) : null,
            planJson: state.plan.length > 0 ? JSON.stringify(state.plan) : null,
            loadedSkillsJson: state.loadedSkills.length > 0 ? JSON.stringify(state.loadedSkills) : null,
            metricsJson: JSON.stringify({ latency: trace.latency }),
            evalJson: input.evaluation ? JSON.stringify(input.evaluation) : null,
            toolCallCount: state.toolCallCount,
            iterationCount: state.iteration,
            delegationCount: state.delegationCount,
            inputTokens: state.tokenUsage.input,
            outputTokens: state.tokenUsage.output,
            totalTokens: state.tokenUsage.total,
            durationMs: trace.totalLatencyMs ?? null,
            completedAt: new Date(),
        }).where(eq(agentRuns.runKey, input.runKey))
    } catch (error) {
        logStoreError("finishRun", error, { runKey: input.runKey })
    }
}

export async function persistTrace(trace: AgentTrace): Promise<void> {
    if (trace.steps.length === 0) return
    try {
        await getDb().insert(agentTraceEvents).values(trace.steps.map((event) => ({
            runKey: trace.runId,
            sequence: event.sequence,
            eventType: event.type,
            payloadJson: JSON.stringify(event.payload),
            toolId: typeof event.payload.toolId === "string" ? event.payload.toolId : null,
        }))).onConflictDoNothing()

        // 工具调用单独展开成事件，便于按 toolId 查询与 Debug UI 明细
        if (trace.toolCalls.length > 0) {
            await getDb().insert(agentTraceEvents).values(trace.toolCalls.map((call, index) => ({
                runKey: trace.runId,
                sequence: trace.steps.length + index + 1,
                eventType: call.ok ? "tool_result" : "error",
                payloadJson: JSON.stringify(call),
                toolId: call.toolId,
            }))).onConflictDoNothing()
        }
    } catch (error) {
        logStoreError("persistTrace", error, { runKey: trace.runId })
    }
}

export async function persistEvidence(runKey: string, evidence: AgentEvidence[]): Promise<void> {
    if (evidence.length === 0) return
    try {
        await getDb().insert(agentEvidence).values(evidence.map((item) => ({
            runKey,
            evidenceKey: item.id,
            source: item.source,
            title: item.title ?? null,
            // 正文按现有数据策略截断，避免 trace 表被单条撑爆
            content: item.content.slice(0, 20_000),
            sourceId: item.sourceId ?? null,
            url: item.url ?? null,
            relevance: item.relevance == null ? null : Math.round(item.relevance * 100),
            confidence: item.confidence == null ? null : Math.round(item.confidence * 100),
            metadataJson: item.metadata ? JSON.stringify(item.metadata) : null,
        }))).onConflictDoNothing()
    } catch (error) {
        logStoreError("persistEvidence", error, { runKey })
    }
}

export async function persistSubtasks(runKey: string, trace: AgentTrace): Promise<void> {
    if (trace.delegations.length === 0) return
    try {
        await getDb().insert(agentSubtasks).values(trace.delegations.map((item) => ({
            runKey,
            taskKey: item.taskId,
            objective: item.objective.slice(0, 2_000),
            status: item.status,
            depth: item.depth,
            evidenceCount: item.evidenceCount,
            durationMs: item.durationMs,
        }))).onConflictDoNothing()
    } catch (error) {
        logStoreError("persistSubtasks", error, { runKey })
    }
}

/** Run 结束后一次性落库；调用方不应 await 阻塞流式响应关闭 */
export async function persistAgentRun(input: {
    state: AgentState
    trace: AgentTrace
    answer: string
    evaluation?: AgentRunEval
    evidence: AgentEvidence[]
}): Promise<void> {
    await Promise.allSettled([
        finishAgentRunRecord({
            runKey: input.state.runId,
            state: input.state,
            trace: input.trace,
            answer: input.answer,
            ...(input.evaluation ? { evaluation: input.evaluation } : {}),
        }),
        persistTrace(input.trace),
        persistEvidence(input.state.runId, input.evidence),
        persistSubtasks(input.state.runId, input.trace),
    ])
}

// ---------------------------------------------------------------------------
// 读取：普通 Run 视图 与 Debug 视图严格分离（§162.38）
// ---------------------------------------------------------------------------

export type AgentRunView = {
    id: string
    conversationId: string
    status: string
    complexity: TaskComplexity
    stopReason?: string
    /** 面向用户的停止说明，不含内部策略名 */
    stopMessage?: string
    goal: string
    answer: string
    plan: AgentPlanStep[]
    loadedSkills: string[]
    activities: AgentActivityView[]
    subagents: AgentSubtaskView[]
    evidence: PublicEvidence[]
    metrics: AgentRunMetrics
    startedAt: number
    completedAt?: number
}

export type AgentActivityView = {
    id: string
    toolId: string
    namespace: string
    status: "completed" | "failed"
    summary: string
    durationMs: number
    evidenceIds: string[]
    startedAt: number
}

export type AgentSubtaskView = {
    id: string
    objective: string
    status: string
    summary?: string
    evidenceCount: number
    durationMs?: number
}

/**
 * 普通 Agent Run 视图：不含 raw tool args、内部 prompt、隐藏推理。
 * Debug UI 用 loadAgentRunTrace 取完整 Trace。
 */
export async function loadAgentRunView(runKey: string, userId: number): Promise<AgentRunView | null> {
    try {
        return await loadAgentRunViewUnsafe(runKey, userId)
    } catch (error) {
        // 读路径同样 fail-open：迁移未执行或查询失败时退化为"没有可恢复的执行视图"，
        // 而不是让聊天页收到 500。真实原因进结构化日志。
        logStoreError("loadRunView", error, { runKey })
        return null
    }
}

async function loadAgentRunViewUnsafe(runKey: string, userId: number): Promise<AgentRunView | null> {
    const db = getDb()
    const [run] = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.runKey, runKey), eq(agentRuns.userId, userId)))
        .limit(1)
    if (!run) return null

    const [events, evidenceRows, subtaskRows] = await Promise.all([
        db.select().from(agentTraceEvents)
            .where(eq(agentTraceEvents.runKey, runKey))
            .orderBy(asc(agentTraceEvents.sequence)),
        db.select().from(agentEvidence)
            .where(eq(agentEvidence.runKey, runKey))
            .orderBy(asc(agentEvidence.createdAt)),
        db.select().from(agentSubtasks)
            .where(eq(agentSubtasks.runKey, runKey))
            .orderBy(asc(agentSubtasks.createdAt)),
    ])

    const activities: AgentActivityView[] = []
    for (const event of events) {
        if (event.eventType !== "tool_result" && event.eventType !== "error") continue
        const payload = parseJson<Record<string, unknown>>(event.payloadJson)
        if (!payload?.toolId) continue
        activities.push({
            id: String(payload.id ?? event.id),
            toolId: String(payload.toolId),
            namespace: String(payload.namespace ?? "system"),
            status: payload.ok === true ? "completed" : "failed",
            summary: String(payload.summary ?? ""),
            durationMs: Number(payload.durationMs ?? 0),
            evidenceIds: Array.isArray(payload.evidenceIds) ? payload.evidenceIds as string[] : [],
            startedAt: Number(payload.startedAt ?? new Date(event.createdAt).getTime()),
        })
    }

    const restoredEvidence: AgentEvidence[] = evidenceRows.map((row) => ({
        id: row.evidenceKey,
        source: row.source as AgentEvidence["source"],
        ...(row.title ? { title: row.title } : {}),
        content: row.content,
        ...(row.sourceId ? { sourceId: row.sourceId } : {}),
        ...(row.url ? { url: row.url } : {}),
        ...(row.relevance != null ? { relevance: row.relevance / 100 } : {}),
        ...(row.confidence != null ? { confidence: row.confidence / 100 } : {}),
        metadata: parseJson<Record<string, unknown>>(row.metadataJson) ?? {},
        createdAt: new Date(row.createdAt).getTime(),
    }))
    const restoredCitationIndices = citationIndicesForEvidence(restoredEvidence)

    return {
        id: run.runKey,
        conversationId: run.conversationId,
        status: run.status,
        complexity: run.complexity as TaskComplexity,
        ...(run.stopReason ? { stopReason: run.stopReason } : {}),
        goal: run.goal,
        answer: run.answer ?? "",
        plan: parseJson<AgentPlanStep[]>(run.planJson) ?? [],
        loadedSkills: parseJson<string[]>(run.loadedSkillsJson) ?? [],
        activities,
        subagents: subtaskRows.map((row) => ({
            id: row.taskKey,
            objective: row.objective,
            status: row.status,
            ...(row.summary ? { summary: row.summary } : {}),
            evidenceCount: row.evidenceCount,
            ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
        })),
        evidence: restoredEvidence.map((item, index) =>
            toPublicEvidence(item, restoredCitationIndices[index])),
        metrics: {
            durationMs: run.durationMs ?? 0,
            toolCalls: run.toolCallCount,
            evidenceCount: evidenceRows.length,
            subAgentCount: subtaskRows.length,
            iterations: run.iterationCount,
        },
        startedAt: new Date(run.startedAt).getTime(),
        ...(run.completedAt ? { completedAt: new Date(run.completedAt).getTime() } : {}),
    }
}

/** Debug 视图：完整 Trace 事件 + token/latency，仅调试入口可访问 */
export async function loadAgentRunTrace(runKey: string, userId: number) {
    try {
        return await loadAgentRunTraceUnsafe(runKey, userId)
    } catch (error) {
        logStoreError("loadRunTrace", error, { runKey })
        return null
    }
}

async function loadAgentRunTraceUnsafe(runKey: string, userId: number) {
    const db = getDb()
    const [run] = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.runKey, runKey), eq(agentRuns.userId, userId)))
        .limit(1)
    if (!run) return null

    const events = await db
        .select()
        .from(agentTraceEvents)
        .where(eq(agentTraceEvents.runKey, runKey))
        .orderBy(asc(agentTraceEvents.sequence))

    return {
        run: {
            ...run,
            routingHint: parseJson<RoutingHint>(run.routingHintJson),
            plan: parseJson<AgentPlanStep[]>(run.planJson) ?? [],
            metrics: parseJson<Record<string, unknown>>(run.metricsJson) ?? {},
            evaluation: parseJson<AgentRunEval>(run.evalJson),
        },
        events: events.map((event) => ({
            sequence: event.sequence,
            type: event.eventType,
            toolId: event.toolId,
            payload: parseJson<Record<string, unknown>>(event.payloadJson) ?? {},
            createdAt: new Date(event.createdAt).getTime(),
        })),
    }
}

export async function listAgentRunsForConversation(conversationId: string, userId: number, limit = 50) {
    try {
        return await listAgentRunsUnsafe(conversationId, userId, limit)
    } catch (error) {
        logStoreError("listRuns", error, { conversationId })
        return []
    }
}

async function listAgentRunsUnsafe(conversationId: string, userId: number, limit: number) {
    return await getDb()
        .select({
            runKey: agentRuns.runKey,
            status: agentRuns.status,
            complexity: agentRuns.complexity,
            stopReason: agentRuns.stopReason,
            startedAt: agentRuns.startedAt,
            completedAt: agentRuns.completedAt,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.userId, userId)))
        .orderBy(desc(agentRuns.startedAt))
        .limit(limit)
}

function parseJson<T>(value: string | null): T | undefined {
    if (!value) return undefined
    try {
        return JSON.parse(value) as T
    } catch {
        return undefined
    }
}

/** 仅供测试：日志格式是排障入口，必须被覆盖 */
export const __testing = { logStoreError }
