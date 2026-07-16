/** 把模型/流里的 usage 压成 UI 认的扁平 token 字段。 */

export type FlatTokenUsage = {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asNonNegNumber(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
    return value
}

function nestedTotal(value: unknown): number | undefined {
    const direct = asNonNegNumber(value)
    if (direct !== undefined) return direct
    const record = asRecord(value)
    return record ? asNonNegNumber(record.total) : undefined
}

export function flattenAssistantUsage(value: unknown): FlatTokenUsage | undefined {
    const record = asRecord(value)
    if (!record) return undefined

    const inputTokens = nestedTotal(record.inputTokens)
    const outputTokens = nestedTotal(record.outputTokens)
    const reasoningTokens = asNonNegNumber(record.reasoningTokens)
        ?? nestedTotal(asRecord(record.outputTokens)?.reasoning)
    const cachedInputTokens = asNonNegNumber(record.cachedInputTokens)
        ?? nestedTotal(asRecord(record.inputTokens)?.cacheRead)
    const totalTokens = asNonNegNumber(record.totalTokens)
        ?? (
            inputTokens !== undefined || outputTokens !== undefined
                ? (inputTokens ?? 0) + (outputTokens ?? 0)
                : undefined
        )

    const result: FlatTokenUsage = {}
    if (inputTokens !== undefined) result.inputTokens = inputTokens
    if (outputTokens !== undefined) result.outputTokens = outputTokens
    if (totalTokens !== undefined) result.totalTokens = totalTokens
    if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens
    if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens
    return Object.keys(result).length > 0 ? result : undefined
}
