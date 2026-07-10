// 站内 Assistant 工具韧性（契约 4.7）+ Playbook（契约 4.2）：
// 单次超时 + 同名连续失败耗尽 + 换招/降级/熔断指导。
// per-run 实例；不跨 run 共享状态。不自动代执行其他工具。

export const TOOL_TIMEOUT_MS = 30_000
export const TOOL_RETRY_EXHAUST_THRESHOLD = 2

export type ToolResilienceErrorCode =
    | "tool_timeout"
    | "tool_retry_exhausted"
    | "tool_error"
    | "tool_degraded"
    | "tool_circuit_open"

export type ResilienceDecisionAction =
    | "retry_other_tool"
    | "answer_without_tool"
    | "circuit_open"

export type ResilienceDecision = {
    action: ResilienceDecisionAction
    messageForModel: string
}

export type PlaybookToolResult = {
    ok: false
    errorCode: "tool_degraded" | "tool_circuit_open"
    action: ResilienceDecisionAction
    message: string
}

export class ToolResilienceError extends Error {
    readonly code: ToolResilienceErrorCode

    constructor(code: ToolResilienceErrorCode, message: string) {
        super(message)
        this.name = "ToolResilienceError"
        this.code = code
    }
}

export type ToolCallMeta = {
    errorCode: ToolResilienceErrorCode | null
    durationMs: number
}

export type ToolResilienceController = {
    run: <T>(toolName: string, execute: () => Promise<T>) => Promise<T | PlaybookToolResult>
    consumeMeta: (toolName: string) => ToolCallMeta | null
}

export function isPlaybookToolResult(value: unknown): value is PlaybookToolResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return record.ok === false
        && (record.errorCode === "tool_degraded" || record.errorCode === "tool_circuit_open")
        && typeof record.action === "string"
        && typeof record.message === "string"
}

export function decideToolFailure(input: {
    toolName: string
    errorCode: string
    failStreak: number
    exhaustThreshold?: number
}): ResilienceDecision {
    const threshold = input.exhaustThreshold ?? TOOL_RETRY_EXHAUST_THRESHOLD
    const name = input.toolName

    if (
        input.errorCode === "tool_retry_exhausted"
        || input.errorCode === "tool_circuit_open"
        || input.failStreak >= threshold
    ) {
        return {
            action: "circuit_open",
            messageForModel: `工具「${name}」本轮已熔断（连续失败）。请改用其他可用工具，或基于已有信息直接回答；不要再次调用「${name}」。`,
        }
    }

    if (input.errorCode === "tool_timeout") {
        return {
            action: "retry_other_tool",
            messageForModel: `工具「${name}」执行超时。请换用其他相关工具或缩小范围后重试；若非必要可直接回答。`,
        }
    }

    if (input.failStreak >= threshold - 1) {
        return {
            action: "answer_without_tool",
            messageForModel: `工具「${name}」再次失败。建议停止依赖该工具，基于已掌握信息直接回答，或改用完全不同的工具。`,
        }
    }

    return {
        action: "retry_other_tool",
        messageForModel: `工具「${name}」执行失败。请换招：改用其他工具、调整参数，或直接回答。`,
    }
}

export function createToolResilienceController(options?: {
    timeoutMs?: number
    exhaustThreshold?: number
}): ToolResilienceController {
    const timeoutMs = options?.timeoutMs ?? TOOL_TIMEOUT_MS
    const exhaustThreshold = options?.exhaustThreshold ?? TOOL_RETRY_EXHAUST_THRESHOLD
    const failStreak = new Map<string, number>()
    const lastMeta = new Map<string, ToolCallMeta>()

    const softFail = (
        toolName: string,
        errorCode: string,
        streak: number,
        durationMs: number,
    ): PlaybookToolResult => {
        const decision = decideToolFailure({
            toolName,
            errorCode,
            failStreak: streak,
            exhaustThreshold,
        })
        const playbookCode: PlaybookToolResult["errorCode"] =
            decision.action === "circuit_open" ? "tool_circuit_open" : "tool_degraded"
        lastMeta.set(toolName, { errorCode: playbookCode, durationMs })
        return {
            ok: false,
            errorCode: playbookCode,
            action: decision.action,
            message: decision.messageForModel,
        }
    }

    return {
        async run(toolName, execute) {
            const streak = failStreak.get(toolName) ?? 0
            if (streak >= exhaustThreshold) {
                return softFail(toolName, "tool_retry_exhausted", streak, 0)
            }

            const startedAt = Date.now()
            try {
                const result = await raceWithTimeout(execute, timeoutMs, toolName)
                failStreak.set(toolName, 0)
                lastMeta.set(toolName, { errorCode: null, durationMs: Date.now() - startedAt })
                return result
            } catch (error) {
                const code = resolveErrorCode(error)
                const nextStreak = streak + 1
                failStreak.set(toolName, nextStreak)
                return softFail(toolName, code, nextStreak, Date.now() - startedAt)
            }
        },
        consumeMeta(toolName) {
            const meta = lastMeta.get(toolName) ?? null
            lastMeta.delete(toolName)
            return meta
        },
    }
}

function resolveErrorCode(error: unknown): ToolResilienceErrorCode {
    if (error instanceof ToolResilienceError) return error.code
    return "tool_error"
}

async function raceWithTimeout<T>(
    execute: () => Promise<T>,
    timeoutMs: number,
    toolName: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            execute(),
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new ToolResilienceError(
                        "tool_timeout",
                        `工具 ${toolName} 执行超时（${timeoutMs}ms）`,
                    ))
                }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
