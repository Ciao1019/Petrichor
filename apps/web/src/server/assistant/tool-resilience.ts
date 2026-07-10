// 站内 Assistant 工具韧性（契约 4.7）：单次超时 + 同名连续失败耗尽。
// per-run 实例；不跨 run 共享状态。

export const TOOL_TIMEOUT_MS = 30_000
export const TOOL_RETRY_EXHAUST_THRESHOLD = 2

export type ToolResilienceErrorCode = "tool_timeout" | "tool_retry_exhausted" | "tool_error"

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
    run: <T>(toolName: string, execute: () => Promise<T>) => Promise<T>
    consumeMeta: (toolName: string) => ToolCallMeta | null
}

export function createToolResilienceController(options?: {
    timeoutMs?: number
    exhaustThreshold?: number
}): ToolResilienceController {
    const timeoutMs = options?.timeoutMs ?? TOOL_TIMEOUT_MS
    const exhaustThreshold = options?.exhaustThreshold ?? TOOL_RETRY_EXHAUST_THRESHOLD
    const failStreak = new Map<string, number>()
    const lastMeta = new Map<string, ToolCallMeta>()

    return {
        async run(toolName, execute) {
            const streak = failStreak.get(toolName) ?? 0
            if (streak >= exhaustThreshold) {
                const error = new ToolResilienceError(
                    "tool_retry_exhausted",
                    `工具 ${toolName} 连续失败已达上限，本轮不再重试`,
                )
                lastMeta.set(toolName, { errorCode: "tool_retry_exhausted", durationMs: 0 })
                throw error
            }

            const startedAt = Date.now()
            try {
                const result = await raceWithTimeout(execute, timeoutMs, toolName)
                failStreak.set(toolName, 0)
                lastMeta.set(toolName, { errorCode: null, durationMs: Date.now() - startedAt })
                return result
            } catch (error) {
                const code = resolveErrorCode(error)
                failStreak.set(toolName, streak + 1)
                lastMeta.set(toolName, { errorCode: code, durationMs: Date.now() - startedAt })
                if (error instanceof ToolResilienceError) throw error
                throw new ToolResilienceError(
                    code,
                    error instanceof Error ? error.message : String(error),
                )
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
