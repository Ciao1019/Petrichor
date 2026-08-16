import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { UIMessage } from "ai"
import { callChatCompletion } from "@/server/ai/generation"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { assistantMessages, assistantThreads } from "@/server/db/schema"
import {
    buildInstructionsWithContextExtras,
    recallRelevantHistory,
    type RecalledSnippet,
} from "./context-recall"
import { extractMessagePlainText } from "./message-text"

export { extractMessagePlainText } from "./message-text"

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
    recalledSnippets?: RecalledSnippet[]
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

/** 从后往前数 keepRecentTurns 个 user 轮次，更早的消息做 tool result 折叠 */
export function findToolCompactCutoff(messages: unknown[], keepRecentTurns = 2): number {
    const keep = Math.max(1, keepRecentTurns)
    let userTurns = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!message || typeof message !== "object") continue
        if ((message as { role?: unknown }).role !== "user") continue
        userTurns += 1
        if (userTurns >= keep) return index
    }
    return 0
}

function asMessageRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function readPartToolName(part: Record<string, unknown>): string {
    if (typeof part.toolName === "string") return part.toolName
    if (typeof part.type === "string" && part.type.startsWith("tool-") && part.type !== "tool-call" && part.type !== "tool-invocation") {
        return part.type.slice("tool-".length)
    }
    return ""
}

function summarizeCompactToolOutput(toolName: string, output: unknown): Record<string, unknown> {
    if (!output || typeof output !== "object" || Array.isArray(output)) {
        return { toolName, ok: false, summary: "compacted" }
    }
    const record = output as Record<string, unknown>
    const ok = record.ok !== false && record.error == null && record.errorCode == null
    const idKeys = [
        "id", "articleId", "documentId", "knowledgeBaseId", "libraryId",
        "confirmationId", "planId", "shareId", "configId",
    ]
    const ids: string[] = []
    for (const key of idKeys) {
        const value = record[key]
        if (value != null && (typeof value === "string" || typeof value === "number")) {
            ids.push(`${key}=${value}`)
        }
    }
    const message = typeof record.message === "string"
        ? record.message.slice(0, 120)
        : typeof record.error === "string"
            ? record.error.slice(0, 120)
            : null
    return {
        toolName,
        ok,
        ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
        summary: ids.length > 0 ? ids.join(", ") : (message ?? "compacted"),
    }
}

/**
 * 压缩较早轮次的 tool result：保留最近 keepRecentTurns 轮全文，更早的只留短摘要。
 */
export function compactToolParts<T>(messages: T[], options?: { keepRecentTurns?: number }): T[] {
    if (messages.length === 0) return messages
    const cutoff = findToolCompactCutoff(messages, options?.keepRecentTurns ?? 2)
    if (cutoff <= 0) return messages

    return messages.map((message, index) => {
        if (index >= cutoff) return message
        const record = asMessageRecord(message)
        if (!record || !Array.isArray(record.parts)) return message
        const parts = record.parts.map((rawPart) => {
            const part = asMessageRecord(rawPart)
            if (!part) return rawPart
            const type = typeof part.type === "string" ? part.type : ""
            const isToolPart = type.startsWith("tool-") || type === "dynamic-tool"
            if (!isToolPart) return rawPart
            const toolName = readPartToolName(part) || "tool"
            const next = { ...part }
            if ("output" in next) next.output = summarizeCompactToolOutput(toolName, next.output)
            if ("result" in next) next.result = summarizeCompactToolOutput(toolName, next.result)
            return next
        })
        return { ...record, parts } as T
    })
}

export function buildFoldableTranscript(messages: unknown[]): string {
    return messages
        .map(extractMessagePlainText)
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 24_000)
}

export function buildInstructionsWithContextSummary(
    basePrompt: string,
    summaryMd: string | null,
    recalledSnippets?: RecalledSnippet[] | null,
): string {
    return buildInstructionsWithContextExtras(basePrompt, summaryMd, recalledSnippets)
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
    modelRefId?: number | null
    signal?: AbortSignal
    /** 确认 resume 等场景跳过摘要刷新，仍做窗口切分与 tool 压缩 */
    skipRefresh?: boolean
    onCompressStart?: () => void
}): Promise<ContextPack> {
    const compactedMessages = compactToolParts(input.messages, { keepRecentTurns: 2 })
    const windowPolicy = resolveRecentWindowPolicy({
        messages: compactedMessages,
        tokenBudget: input.tokenBudget,
    })
    const { foldable, recent } = splitRecentMessages(compactedMessages, windowPolicy.recentCount)
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
    const needsRefresh = !input.skipRefresh
        && shouldRefreshContextSummary({
            messages: compactedMessages,
            tokenBudget: input.tokenBudget,
            persistedMessageCount: persistedCount,
            recentCount: windowPolicy.recentCount,
        })
        && foldable.length > 0

    const recalledSnippets = await maybeRecallSnippets({
        userId: input.userId,
        threadId: input.threadId,
        messages: compactedMessages,
        recentCount: windowPolicy.recentCount,
        persistedCount,
    })

    if (!needsRefresh) {
        return {
            summaryMd: existingSummary,
            recentMessages: existingSummary ? recent as UIMessage[] : compactedMessages as UIMessage[],
            compressedMessageCount: existingSummary
                ? Math.max(0, compactedMessages.length - recent.length)
                : 0,
            refreshed: false,
            status: "skipped",
            windowPolicy,
            recalledSnippets,
        }
    }

    input.onCompressStart?.()

    try {
        const transcript = buildFoldableTranscript(foldable)
        const summaryMd = await summarizeContextWithTimeout({
            userId: input.userId,
            modelRefId: input.modelRefId ?? null,
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
            recalledSnippets,
        }
    } catch {
        return {
            summaryMd: existingSummary,
            recentMessages: existingSummary ? recent as UIMessage[] : compactedMessages as UIMessage[],
            compressedMessageCount: existingSummary
                ? Math.max(0, compactedMessages.length - recent.length)
                : 0,
            refreshed: false,
            status: "failed",
            windowPolicy,
            recalledSnippets,
        }
    }
}

async function maybeRecallSnippets(input: {
    userId: number
    threadId: number
    messages: UIMessage[]
    recentCount: number
    persistedCount: number
}): Promise<RecalledSnippet[]> {
    if (input.persistedCount <= input.recentCount) return []
    const query = extractLastUserPlainText(input.messages)
    if (!query) return []
    const excludeMessageIds = await listRecentPersistedMessageIds(input.threadId, input.recentCount)
    return await recallRelevantHistory({
        userId: input.userId,
        threadId: input.threadId,
        query,
        excludeMessageIds,
    })
}

function extractLastUserPlainText(messages: UIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (!message || message.role !== "user") continue
        const text = extractMessagePlainText(message)
        if (text) return text.replace(/^user:\s*/i, "").trim()
    }
    return ""
}

async function listRecentPersistedMessageIds(threadId: number, recentCount: number) {
    const rows = await getDb()
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, threadId))
        .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
        .limit(Math.max(1, recentCount))
    return rows.map((row) => row.id).reverse()
}

async function countThreadMessages(threadId: number) {
    const countExpr = isSqliteDatabase()
        ? sql<number>`count(*)`
        : sql<number>`count(*)::int`
    const [row] = await getDb()
        .select({ value: countExpr })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, threadId))
    return Number(row?.value ?? 0)
}

/** 水位：排除最近 recentCount 条后的最大 message.id */
async function findWatermarkMessageId(threadId: number, recentCount: number) {
    const window = Math.max(1, recentCount) + 1
    const rows = await getDb()
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, threadId))
        .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
        .limit(window)
    if (rows.length <= recentCount) return rows.at(-1)?.id ?? null
    return rows[recentCount]?.id ?? null
}

async function summarizeContextWithTimeout(input: {
    userId: number
    modelRefId: number | null
    previousSummary: string | null
    transcript: string
    signal?: AbortSignal
}) {
    if (input.signal?.aborted) throw new Error("context summary aborted")

    const completion = callChatCompletion({
        userId: input.userId,
        modelRefId: input.modelRefId,
        systemPrompt: [
            "你是对话上下文压缩器。把较早的多轮对话压成简洁中文摘要，保留：用户目标、已确认事实、未决任务、关键实体 ID/路径（如 articleId、knowledgeBaseId、documentId）。",
            "工具结果若已折叠，优先保留其中的 id 与错误码。",
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
