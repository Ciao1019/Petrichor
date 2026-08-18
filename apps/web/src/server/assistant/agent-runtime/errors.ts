import type { AgentToolErrorCode, AgentToolErrorShape } from "./types"

/**
 * 统一 Agent 错误（§140）。所有工具/技能/子代理失败都归一到这里，
 * 便于 Observation 转换、重试判定与 Trace 记录。
 */
export class AgentError extends Error {
    readonly code: AgentToolErrorCode
    readonly retryable: boolean
    readonly details?: unknown

    constructor(code: AgentToolErrorCode, message: string, options?: { retryable?: boolean; details?: unknown }) {
        super(message)
        this.name = "AgentError"
        this.code = code
        this.retryable = options?.retryable ?? DEFAULT_RETRYABLE.has(code)
        this.details = options?.details
    }

    toShape(): AgentToolErrorShape {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.details === undefined ? {} : { details: this.details }),
        }
    }
}

/** 默认可重试的错误码（§60）：网络/超时类有限重试，权限类绝不重试 */
const DEFAULT_RETRYABLE = new Set<AgentToolErrorCode>([
    "TOOL_TIMEOUT",
    "TOOL_EXECUTION_ERROR",
    "RETRIEVAL_FAILED",
    "RERANK_FAILED",
])

/** 参数校验失败：不重试同参数，但允许模型修正参数后再调用 */
export function validationError(message: string, details?: unknown): AgentError {
    return new AgentError("TOOL_VALIDATION_ERROR", message, { retryable: false, details })
}

export function permissionDenied(message: string, details?: unknown): AgentError {
    return new AgentError("TOOL_PERMISSION_DENIED", message, { retryable: false, details })
}

export function toolTimeout(toolId: string, timeoutMs: number): AgentError {
    return new AgentError("TOOL_TIMEOUT", `工具 ${toolId} 执行超时（${timeoutMs}ms）`, { retryable: true })
}

export function toolAborted(toolId: string): AgentError {
    return new AgentError("TOOL_ABORTED", `工具 ${toolId} 已被取消`, { retryable: false })
}

export function skillNotFound(skillId: string, available: string[]): AgentError {
    return new AgentError("SKILL_NOT_FOUND", `未知 skill：${skillId}`, {
        retryable: false,
        details: { available },
    })
}

/** 把任意 throw 值归一成 AgentError */
export function normalizeAgentError(error: unknown, fallbackCode: AgentToolErrorCode = "TOOL_EXECUTION_ERROR"): AgentError {
    if (error instanceof AgentError) return error
    if (isAbortError(error)) return new AgentError("TOOL_ABORTED", "执行已取消", { retryable: false })

    const message = error instanceof Error ? error.message : String(error)
    // HttpError（服务端既有错误类型）带 status；4xx 视为参数/权限问题，不重试
    const status = readStatus(error)
    if (status === 401 || status === 403) {
        return new AgentError("TOOL_PERMISSION_DENIED", message, { retryable: false })
    }
    if (status != null && status >= 400 && status < 500) {
        return new AgentError("TOOL_VALIDATION_ERROR", message, { retryable: false })
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
        return new AgentError("TOOL_TIMEOUT", message, { retryable: true })
    }
    return new AgentError(fallbackCode, message)
}

export function isAbortError(error: unknown): boolean {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true
    return typeof error === "string" && /abort/i.test(error)
}

function readStatus(error: unknown): number | null {
    if (!error || typeof error !== "object") return null
    const status = (error as { status?: unknown }).status
    return typeof status === "number" ? status : null
}
