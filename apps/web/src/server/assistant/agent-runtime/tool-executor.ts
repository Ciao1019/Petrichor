import { TOOL_DEFAULT_MAX_RETRIES, TOOL_DEFAULT_TIMEOUT_MS } from "./config"
import { AgentError, normalizeAgentError, permissionDenied, toolAborted, toolTimeout, validationError } from "./errors"
import type { EvidenceStore } from "./evidence"
import { AgentEventEmitter, toPublicEvidence, toPublicObservation } from "./events"
import { newId } from "./ids"
import type { LoopDetector } from "./loop-detector"
import { createObservation, defaultSummarize, errorObservation, type ObservationStore } from "./observation"
import { permissionContextFrom, type PermissionResolver } from "./permissions"
import type { AgentStateStore } from "./state"
import type { AgentToolRegistry } from "./tool-registry"
import type { TraceCollector } from "./trace"
import type {
    AgentEvidence,
    AgentObservation,
    AgentToolDefinition,
    AgentToolTrace,
    ToolExecutionContext,
    ToolExecutionResult,
} from "./types"
import { toolActivityTitle } from "@/lib/agent/tool-ui"

/**
 * 统一工具执行器（§13）。
 *
 * 任何工具调用都必须经过这里，负责：
 * 权限 → 参数校验 → 副作用确认 → 超时 → 重试 → Trace → Observation → Evidence → 循环登记。
 * 禁止 Agent 绕过本执行器直接调用工具。
 */

export type ToolExecutorDeps = {
    registry: AgentToolRegistry
    permissions: PermissionResolver
    observations: ObservationStore
    evidence: EvidenceStore
    state: AgentStateStore
    trace: TraceCollector
    loopDetector: LoopDetector
    events?: AgentEventEmitter
    /** 委派授权的工具白名单；主 Agent 为 undefined */
    allowedToolIds?: string[]
    /** 副作用工具确认策略（§47）：返回 false 表示拒绝执行 */
    confirmSideEffect?: (tool: AgentToolDefinition, input: unknown) => Promise<boolean>
    /** 单次工具超时上限，由 Budget 收窄 */
    clampTimeout?: (desiredMs: number) => number
    /**
     * 每次工具执行落 Trace 后回调。
     * 用于向后兼容既有的 petrichor_assistant_step 表——
     * listRecentToolNames 与历史 UI 都依赖它，不能因为换了 Runtime 就断供（§108）。
     */
    onToolTrace?: (trace: AgentToolTrace) => void
}

export type ToolRunOutcome = ToolExecutionResult & {
    toolId: string
    observation: AgentObservation
    evidence: AgentEvidence[]
    /** 与 EvidenceStore 首次入库顺序一致的稳定引用编号 */
    evidenceCitationIndices: number[]
}

export class ToolExecutor {
    constructor(private readonly deps: ToolExecutorDeps) {}

    async execute(toolId: string, rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolRunOutcome> {
        const startedAt = Date.now()
        const callId = newId("call")
        const tool = this.deps.registry.get(toolId)

        if (!tool) {
            return this.fail(
                callId,
                { id: toolId, name: toolId, namespace: "system" as const },
                validationError(`未注册的工具：${toolId}`),
                rawInput,
                startedAt,
                0,
            )
        }

        this.deps.events?.emit("tool_started", {
            callId,
            toolId: tool.id,
            namespace: tool.namespace,
            title: toolActivityTitle(tool.id, rawInput),
        })

        // 1) 权限（§48）：拒绝即不执行、不重试、Trace permission_denied
        const decision = await this.deps.permissions.canUseTool(
            ctx.userId,
            tool.id,
            permissionContextFrom(ctx, this.deps.allowedToolIds),
        )
        if (!decision.allowed) {
            return this.fail(
                callId,
                tool,
                permissionDenied(decision.reason ?? `无权使用工具 ${tool.id}`),
                rawInput,
                startedAt,
                0,
                "denied",
            )
        }

        // 2) 参数校验（§99）：无效参数不执行工具，返回可修正的 observation
        let input: unknown = rawInput
        const parsed = safeParseSchema(tool.inputSchema, rawInput)
        if (!parsed.ok) {
            return this.fail(callId, tool, validationError(parsed.message, parsed.issues), rawInput, startedAt, 0)
        }
        input = parsed.value

        // 3) 副作用确认（§47/§132）
        if (tool.requiresConfirmation && this.deps.confirmSideEffect) {
            const confirmed = await this.deps.confirmSideEffect(tool, input)
            if (!confirmed) {
                return this.fail(
                    callId,
                    tool,
                    permissionDenied(`操作 ${tool.id} 需要用户确认，尚未获得确认`),
                    input,
                    startedAt,
                    0,
                    "denied",
                )
            }
        }

        // 4) 执行 + 超时 + 有限重试（§60）
        const maxRetries = tool.maxRetries ?? TOOL_DEFAULT_MAX_RETRIES
        const desiredTimeout = tool.timeoutMs ?? TOOL_DEFAULT_TIMEOUT_MS
        const timeoutMs = this.deps.clampTimeout?.(desiredTimeout) ?? desiredTimeout

        let retries = 0
        let lastError: AgentError | null = null
        while (retries <= maxRetries) {
            try {
                const output = await runWithTimeout(
                    (signal) => tool.execute({ ...ctx, abortSignal: signal }, input),
                    timeoutMs,
                    ctx.abortSignal,
                    tool.id,
                )
                return this.succeed(callId, tool, input, output, startedAt, retries)
            } catch (error) {
                const agentError = normalizeAgentError(error)
                lastError = agentError
                // 取消与不可重试错误立即返回；权限类永不重试
                if (!agentError.retryable || ctx.abortSignal?.aborted) break
                retries += 1
                if (retries > maxRetries) break
                this.deps.events?.emit("tool_failed", {
                    callId,
                    toolId: tool.id,
                    namespace: tool.namespace,
                    errorCode: agentError.code,
                    message: userFacingMessage(agentError),
                    durationMs: Date.now() - startedAt,
                    willRetry: true,
                })
            }
        }

        return this.fail(callId, tool, lastError ?? normalizeAgentError(new Error("未知错误")), input, startedAt, retries)
    }

    private succeed(
        callId: string,
        tool: AgentToolDefinition,
        input: unknown,
        output: unknown,
        startedAt: number,
        retries: number,
    ): ToolRunOutcome {
        const durationMs = Date.now() - startedAt
        const normalized = tool.normalize?.(output, input)
        const summary = normalized?.summary ?? defaultSummarize(tool.id, output)
        const evidence = this.deps.evidence.addMany(normalized?.evidence ?? [])
        const evidenceIds = evidence.map((item) => item.id)
        const evidenceCitationIndices = evidence.map((item) => this.deps.evidence.citationIndex(item.id))

        const observation = this.deps.observations.add(createObservation({
            type: observationType(tool.id),
            source: tool.id,
            summary,
            ...(normalized?.data === undefined ? {} : { data: normalized.data }),
            evidenceIds,
            ...(normalized?.suggestedActions?.length ? { suggestedActions: normalized.suggestedActions } : {}),
        }))

        this.deps.state.addObservation(observation)
        this.deps.state.addEvidence(evidence)
        this.deps.state.incrementToolCall()

        const toolTrace: AgentToolTrace = {
            id: callId,
            toolId: tool.id,
            toolName: tool.name,
            namespace: tool.namespace,
            input,
            rawOutput: output,
            summary,
            ok: true,
            durationMs,
            retries,
            evidenceIds,
            permissionDecision: "allowed",
            startedAt,
        }
        this.deps.trace.recordToolCall(toolTrace)
        const retrievalDiagnostics = readRetrievalDiagnostics(tool.id, output)
        if (retrievalDiagnostics) {
            this.deps.trace.recordRetrievalDiagnostics(retrievalDiagnostics)
        }
        this.deps.onToolTrace?.(toolTrace)

        // 进展判定优先用归一化器给的显式信号：检索类工具产候选不产证据，同样算进展
        const progressed = normalized?.progress ?? evidence.length > 0
        this.deps.loopDetector.record({
            toolId: tool.id,
            input,
            output,
            producedEvidence: progressed,
        })

        this.deps.events?.emit("tool_completed", {
            callId,
            toolId: tool.id,
            namespace: tool.namespace,
            summary,
            durationMs,
            evidenceIds,
        })
        this.deps.events?.emit("observation_created", { observation: toPublicObservation(observation) })
        if (evidence.length > 0) {
            this.deps.events?.emit("evidence_created", { evidence: evidence.map(toPublicEvidence) })
        }

        return {
            ok: true,
            output,
            durationMs,
            retries,
            toolId: tool.id,
            observation,
            evidence,
            evidenceCitationIndices,
        }
    }

    private fail(
        callId: string,
        tool: Pick<AgentToolDefinition, "id" | "name" | "namespace">,
        error: AgentError,
        input: unknown,
        startedAt: number,
        retries: number,
        permissionDecision: "allowed" | "denied" = "allowed",
    ): ToolRunOutcome {
        const durationMs = Date.now() - startedAt
        const shape = error.toShape()
        const observation = this.deps.observations.add(errorObservation(tool, shape))

        this.deps.state.addObservation(observation)
        // 失败也计入工具预算：否则连续失败会绕过 maxToolCalls 无限重试
        this.deps.state.incrementToolCall()

        const toolTrace: AgentToolTrace = {
            id: callId,
            toolId: tool.id,
            toolName: tool.name,
            namespace: tool.namespace,
            input,
            summary: shape.message,
            ok: false,
            errorCode: shape.code,
            durationMs,
            retries,
            evidenceIds: [],
            permissionDecision,
            startedAt,
        }
        this.deps.trace.recordToolCall(toolTrace)
        this.deps.onToolTrace?.(toolTrace)

        this.deps.loopDetector.record({ toolId: tool.id, input, producedEvidence: false })

        this.deps.events?.emit("tool_failed", {
            callId,
            toolId: tool.id,
            namespace: tool.namespace,
            errorCode: shape.code,
            message: userFacingMessage(error),
            durationMs,
            willRetry: false,
        })
        this.deps.events?.emit("observation_created", { observation: toPublicObservation(observation) })

        return {
            ok: false,
            error: shape,
            durationMs,
            retries,
            toolId: tool.id,
            observation,
            evidence: [],
            evidenceCitationIndices: [],
        }
    }
}

/**
 * knowledge.search / knowledge.lookup 的诊断只进入 Trace，不进入 Observation / 模型上下文。
 * 这样能观测各路召回与 rerank 延迟，同时不把排名明细反复塞回提示词。
 */
function readRetrievalDiagnostics(toolId: string, output: unknown): Record<string, unknown> | null {
    if ((toolId !== "knowledge.search" && toolId !== "knowledge.lookup")
        || output == null
        || typeof output !== "object"
        || Array.isArray(output)) {
        return null
    }
    const diagnostics = (output as Record<string, unknown>).diagnostics
    if (diagnostics == null || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null
    return diagnostics as Record<string, unknown>
}

/** 工具 id → observation.type，如 knowledge.search → knowledge_search */
export function observationType(toolId: string): string {
    return toolId.replace(/\./g, "_")
}

/** 面向用户的错误文案（§162.23）：不暴露堆栈与内部细节 */
export function userFacingMessage(error: AgentError): string {
    switch (error.code) {
        case "TOOL_TIMEOUT":
            return "该来源响应超时，正在尝试其它方式"
        case "TOOL_PERMISSION_DENIED":
            return "当前账号没有执行该操作的权限"
        case "TOOL_VALIDATION_ERROR":
            return "调用参数不正确，正在修正"
        case "TOOL_ABORTED":
            return "操作已取消"
        case "RETRIEVAL_FAILED":
            return "检索暂时不可用，正在尝试其它召回方式"
        default:
            return "该步骤未能完成，正在尝试其它方式"
    }
}

type SchemaParseResult =
    | { ok: true; value: unknown }
    | { ok: false; message: string; issues?: unknown }

/** 鸭子类型识别 zod schema，避免 agent-runtime 直接依赖具体 zod 版本 */
function safeParseSchema(schema: unknown, input: unknown): SchemaParseResult {
    if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== "function") {
        return { ok: true, value: input }
    }
    const result = (schema as { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } })
        .safeParse(input ?? {})
    if (result.success) return { ok: true, value: result.data }
    const issues = (result.error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues ?? []
    const message = issues.length
        ? issues.map((issue) => `${(issue.path ?? []).join(".") || "input"}: ${issue.message ?? "无效"}`).join("; ")
        : "参数校验失败"
    return { ok: false, message, issues }
}

/** 超时 + 外部取消：任一触发都要真正把 signal 传给工具，避免僵尸请求 */
async function runWithTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
    toolId: string,
): Promise<T> {
    if (externalSignal?.aborted) throw toolAborted(toolId)

    const controller = new AbortController()
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort()
            reject(toolTimeout(toolId, timeoutMs))
        }, timeoutMs)
    })

    try {
        return await Promise.race([run(controller.signal), timeout])
    } finally {
        if (timer) clearTimeout(timer)
        externalSignal?.removeEventListener("abort", onExternalAbort)
    }
}
