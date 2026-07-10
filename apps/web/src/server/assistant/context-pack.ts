import { and, asc, desc, eq, isNull } from "drizzle-orm"
import type { UIMessage } from "ai"
import { callChatCompletion } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { assistantMessages, assistantThreads } from "@/server/db/schema"

/** 契约 4.3：最近窗口下限 */
export const CONTEXT_RECENT_MESSAGE_MIN = 6
/** @deprecated 使用 CONTEXT_RECENT_MESSAGE_MIN；保留别名兼容旧测试/调用 */
export const CONTEXT_RECENT_MESSAGE_COUNT = CONTEXT_RECENT_MESSAGE_MIN
/** 条数上限：触顶后 reason=turn_budget */
export const CONTEXT_RECENT_MESSAGE_MAX = 20
/** 最近原文占用的 token 预算比例（相对本轮 tokenBudget） */
export const CONTEXT_RECENT_TOKEN_RATIO = 0.35

export const CONTEXT_COMPRESS_PART_TYPE = "data-context-compress"
export const CONTEXT_SUMMARY_TIMEOUT_MS = 8_000
const MESSAGE_COUNT_TRIGGER = 20
const TOKEN_BUDGET_RATIO = 0.55

export type ContextWindowPolicyReason = "fixed" | "token_budget" | "turn_budget"

export type ContextWindowPolicy = {
    recentCount: number
    reason: ContextWindowPolicyReason
}

export type ContextPack = {
    summaryMd: string | null
    recentMessages: UIMessage[]
    compressedMessageCount: number
    refreshed: boolean
    status: "skipped" | "done" | "failed"
    windowPolicy: ContextWindowPolicy
}

export type ContextCompressPartData = {
    status: "running" | "done" | "skipped" | "failed"
    label: string
}

/** 粗估 token：中文偏多时按字符/2，足够做触发阈值。 */
export function estimateMessageTokens(messages: unknown[]): number {
    const raw = JSON.stringify(messages)
    return Math.ceil(raw.length / 2)
}

/**
 * 动态最近窗口：下限 MIN，上限 MAX；在 recent token 预算内尽量多留原文。
 */
export function resolveRecentWindowPolicy(input: {
    messages: unknown[]
    tokenBudget: number
}): ContextWindowPolicy {
    const total = input.messages.length
    if (total <= CONTEXT_RECENT_MESSAGE_MIN) {
        return { recentCount: total, reason: "fixed" }
    }

    const recentBudget = Math.max(1, Math.floor(input.tokenBudget * CONTEXT_RECENT_TOKEN_RATIO))
    const hardMax = Math.min(CONTEXT_RECENT_MESSAGE_MAX, total)

    let count = CONTEXT_RECENT_MESSAGE_MIN
    for (let n = CONTEXT_RECENT_MESSAGE_MIN + 1; n <= hardMax; n++) {
        const slice = input.messages.slice(-n)
        if (estimateMessageTokens(slice) <= recentBudget) {
            count = n
        } else {
            break
        }
    }

    if (count === CONTEXT_RECENT_MESSAGE_MIN) {
        return { recentCount: count, reason: "fixed" }
    }
    if (count === CONTEXT_RECENT_MESSAGE_MAX) {
        return { recentCount: count, reason: "turn_budget" }
    }
    return { recentCount: count, reason: "token_budget" }
}

export function shouldRefreshContextSummary(input: {
    messages: unknown[]
    tokenBudget: number
    persistedMessageCount: number
    recentCount?: number
}): boolean {
    const recentCount = input.recentCount ?? CONTEXT_RECENT_MESSAGE_MIN
    if (input.messages.length <= recentCount) return false
    const overTokens = estimateMessageTokens(input.messages) > input.tokenBudget * TOKEN_BUDGET_RATIO
    const overCount = input.persistedMessageCount > MESSAGE_COUNT_TRIGGER
    return overTokens || overCount
}

export function splitRecentMessages<T>(messages: T[], recentCount = CONTEXT_RECENT_MESSAGE_MIN): {
    foldable: T[]
    recent: T[]
} {
    const keep = Math.max(0, recentCount)
    if (messages.length <= keep) {
        return { foldable: [], recent: messages }
    }
    return {
        foldable: messages.slice(0, -keep),
        recent: messages.slice(-keep),
    }
}

export function extractMessagePlainText(message: unknown): string {
    if (!message || typeof message !== "object") return ""
    const record = message as { role?: unknown; content?: unknown; parts?: unknown }
    const role = typeof record.role === "string" ? record.role : "unknown"
    if (typeof record.content === "string" && record.content.trim()) {
        return `${role}: ${record.content.trim()}`
    }
    const parts = Array.isArray(record.parts)
        ? record.parts
        : Array.isArray(record.content)
            ? record.content
            : []
    const text = parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { type?: unknown; text?: unknown }
            if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text
            return ""
        })
        .filter(Boolean)
        .join("\n")
        .trim()
    return text ? `${role}: ${text}` : ""
}

export function buildFoldableTranscript(messages: unknown[]): string {
    return messages
        .map(extractMessagePlainText)
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 24_000)
}

export function buildInstructionsWithContextSummary(basePrompt: string, summaryMd: string | null): string {
    if (!summaryMd?.trim()) return basePrompt
    return [
        basePrompt,
        "",
        "以下是本对话较早内容的摘要（已折叠细节，仅供连贯理解；最近几轮原文仍在消息中）：",
        summaryMd.trim(),
    ].join("\n")
}

export function stripContextCompressParts(parts: unknown): unknown[] {
    if (!Array.isArray(parts)) return []
    return parts.filter((part) => {
        if (!part || typeof part !== "object") return true
        const type = (part as { type?: unknown }).type
        return type !== CONTEXT_COMPRESS_PART_TYPE
    })
}

export async function inspectContextCompressNeed(input: {
    userId: number
    threadId: number
    messages: UIMessage[]
    tokenBudget: number
}): Promise<{ needsRefresh: boolean; existingSummary: string | null }> {
    const windowPolicy = resolveRecentWindowPolicy({
        messages: input.messages,
        tokenBudget: input.tokenBudget,
    })
    const { foldable } = splitRecentMessages(input.messages, windowPolicy.recentCount)
    const [thread] = await getDb()
        .select({
            contextSummaryMd: assistantThreads.contextSummaryMd,
        })
        .from(assistantThreads)
        .where(and(
            eq(assistantThreads.id, input.threadId),
            eq(assistantThreads.userId, input.userId),
            isNull(assistantThreads.deletedAt),
        ))
        .limit(1)
    const existingSummary = thread?.contextSummaryMd?.trim() || null
    const persistedCount = await countThreadMessages(input.threadId)
    const needsRefresh = shouldRefreshContextSummary({
        messages: input.messages,
        tokenBudget: input.tokenBudget,
        persistedMessageCount: persistedCount,
        recentCount: windowPolicy.recentCount,
    }) && foldable.length > 0
    return { needsRefresh, existingSummary }
}

export async function buildContextPack(input: {
    userId: number
    threadId: number
    messages: UIMessage[]
    tokenBudget: number
    configId?: number | null
    signal?: AbortSignal
}): Promise<ContextPack> {
    const windowPolicy = resolveRecentWindowPolicy({
        messages: input.messages,
        tokenBudget: input.tokenBudget,
    })
    const { foldable, recent } = splitRecentMessages(input.messages, windowPolicy.recentCount)
    const [thread] = await getDb()
        .select()
        .from(assistantThreads)
        .where(and(
            eq(assistantThreads.id, input.threadId),
            eq(assistantThreads.userId, input.userId),
            isNull(assistantThreads.deletedAt),
        ))
        .limit(1)

    const existingSummary = thread?.contextSummaryMd?.trim() || null
    const persistedCount = await countThreadMessages(input.threadId)
    const needsRefresh = shouldRefreshContextSummary({
        messages: input.messages,
        tokenBudget: input.tokenBudget,
        persistedMessageCount: persistedCount,
        recentCount: windowPolicy.recentCount,
    }) && foldable.length > 0

    if (!needsRefresh) {
        return {
            summaryMd: existingSummary,
            recentMessages: existingSummary ? recent as UIMessage[] : input.messages,
            compressedMessageCount: existingSummary
                ? Math.max(0, input.messages.length - recent.length)
                : 0,
            refreshed: false,
            status: "skipped",
            windowPolicy,
        }
    }

    try {
        const transcript = buildFoldableTranscript(foldable)
        const summaryMd = await summarizeContextWithTimeout({
            userId: input.userId,
            configId: input.configId ?? null,
            previousSummary: existingSummary,
            transcript,
            signal: input.signal,
        })
        const latestFoldedId = await findWatermarkMessageId(input.threadId, recent.length)
        await getDb()
            .update(assistantThreads)
            .set({
                contextSummaryMd: summaryMd,
                contextSummaryUntilMessageId: latestFoldedId,
                contextSummaryUpdatedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(and(
                eq(assistantThreads.id, input.threadId),
                eq(assistantThreads.userId, input.userId),
            ))

        return {
            summaryMd,
            recentMessages: recent as UIMessage[],
            compressedMessageCount: foldable.length,
            refreshed: true,
            status: "done",
            windowPolicy,
        }
    } catch {
        return {
            summaryMd: existingSummary,
            recentMessages: existingSummary ? recent as UIMessage[] : input.messages,
            compressedMessageCount: existingSummary
                ? Math.max(0, input.messages.length - recent.length)
                : 0,
            refreshed: false,
            status: "failed",
            windowPolicy,
        }
    }
}

async function countThreadMessages(threadId: number) {
    const rows = await getDb()
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, threadId))
        .orderBy(desc(assistantMessages.id))
        .limit(500)
    return rows.length
}

/** 水位：排除最近 recentCount 条后的最大 message.id */
async function findWatermarkMessageId(threadId: number, recentCount: number) {
    const rows = await getDb()
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, threadId))
        .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
    if (rows.length <= recentCount) return rows.at(-1)?.id ?? null
    return rows[rows.length - recentCount - 1]?.id ?? null
}

async function summarizeContextWithTimeout(input: {
    userId: number
    configId: number | null
    previousSummary: string | null
    transcript: string
    signal?: AbortSignal
}) {
    if (input.signal?.aborted) throw new Error("context summary aborted")

    const completion = callChatCompletion({
        userId: input.userId,
        configId: input.configId,
        systemPrompt: [
            "你是对话上下文压缩器。把较早的多轮对话压成简洁中文摘要，保留：用户目标、已确认事实、未决任务、关键实体 ID/路径。",
            "不要编造；不要输出 API Key、Cookie、密码；不要使用 Markdown 标题堆砌。",
            "只输出摘要正文。",
        ].join(""),
        messages: [
            ...(input.previousSummary
                ? [{ role: "user" as const, content: `已有摘要：\n${input.previousSummary}` }]
                : []),
            {
                role: "user",
                content: `请将以下较早对话并入摘要：\n\n${input.transcript}`,
            },
        ],
    })

    const result = await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("context summary timeout")), CONTEXT_SUMMARY_TIMEOUT_MS)
            input.signal?.addEventListener("abort", () => {
                clearTimeout(timer)
                reject(new Error("context summary aborted"))
            }, { once: true })
        }),
    ])

    const trimmed = result.answer.trim()
    if (!trimmed) throw new Error("empty context summary")
    return trimmed.slice(0, 8_000)
}
