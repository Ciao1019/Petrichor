import { and, asc, desc, eq, inArray, isNull, like } from "drizzle-orm"
import { z } from "zod"
import { getDb } from "@/server/db/client"
import {
    assistantMessages,
    assistantRuns,
    assistantSteps,
    assistantThreads,
    type AssistantThreadRecord,
} from "@/server/db/schema"
import { notFound } from "@/server/http/response"
import type { AgentDomainId, AssistantFocus } from "./domain-types"
import { listActiveAssistantPlans } from "./plan-store"

export const assistantIdSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw)) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

// 契约 4.1 focus 字段为 string | null；宽进（也接受 number）、归一化为字符串存储
const focusIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value)).nullable().optional()

export const assistantFocusSchema = z.object({
    knowledgeBaseId: focusIdSchema,
    libraryId: focusIdSchema,
    articleId: focusIdSchema,
    documentId: focusIdSchema,
})

export const ASSISTANT_THREAD_DETAIL_MESSAGE_LIMIT = 200

export const assistantThreadListSchema = z.object({
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(100).optional(),
    q: z.string().trim().max(120).optional(),
})

const SENSITIVE_INPUT_KEYS = new Set([
    "apikey",
    "api_key",
    "password",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "authorization",
])

export function redactAssistantStepInput(input: unknown): unknown {
    if (input == null) return input
    if (Array.isArray(input)) return input.map((item) => redactAssistantStepInput(item))
    if (typeof input !== "object") return input
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (SENSITIVE_INPUT_KEYS.has(key.toLowerCase())) {
            next[key] = "[redacted]"
            continue
        }
        next[key] = redactAssistantStepInput(value)
    }
    return next
}

export const assistantThreadDeleteManySchema = z.object({
    threadIds: z.array(assistantIdSchema).min(1).max(200),
})

const DEFAULT_THREAD_TITLE = "新对话"

export function summarizeThreadTitle(text: string, maxLength = 40): string {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (!normalized) return DEFAULT_THREAD_TITLE
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized
}

export function parseAssistantFocus(focusJson: string | null): AssistantFocus | null {
    if (!focusJson) return null
    try {
        const parsed = JSON.parse(focusJson)
        return parsed && typeof parsed === "object" ? parsed as AssistantFocus : null
    } catch {
        return null
    }
}

export function toAssistantThreadResponse(thread: AssistantThreadRecord) {
    return {
        id: String(thread.id),
        title: thread.title,
        focus: parseAssistantFocus(thread.focusJson),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
    }
}

export async function loadAssistantThreadOrThrow(userId: number, threadId: number) {
    const [thread] = await getDb()
        .select()
        .from(assistantThreads)
        .where(and(
            eq(assistantThreads.id, threadId),
            eq(assistantThreads.userId, userId),
            isNull(assistantThreads.deletedAt),
        ))
        .limit(1)
    if (!thread) {
        throw notFound("对话不存在")
    }
    return thread
}

export async function createAssistantThread(input: {
    userId: number
    title?: string | null
    focus?: AssistantFocus | null
}) {
    const now = new Date()
    const [created] = await getDb()
        .insert(assistantThreads)
        .values({
            userId: input.userId,
            title: summarizeThreadTitle(input.title ?? ""),
            focusJson: input.focus ? JSON.stringify(input.focus) : null,
            createdAt: now,
            updatedAt: now,
        })
        .returning({ id: assistantThreads.id })
    return await loadAssistantThreadOrThrow(input.userId, created!.id)
}

export async function ensureAssistantThread(input: {
    userId: number
    threadId: number | null
    title: string
    focus: AssistantFocus | null
}) {
    if (input.threadId != null) {
        return await loadAssistantThreadOrThrow(input.userId, input.threadId)
    }
    return await createAssistantThread({ userId: input.userId, title: input.title, focus: input.focus })
}

export async function persistAssistantMessage(input: {
    userId: number
    threadId: number
    role: "user" | "assistant"
    content: unknown
    titleCandidate?: string
}) {
    const db = getDb()
    const now = new Date()
    await db.insert(assistantMessages).values({
        threadId: input.threadId,
        role: input.role,
        contentJson: JSON.stringify(input.content),
        createdAt: now,
    })
    await db
        .update(assistantThreads)
        .set({
            updatedAt: now,
            ...(input.role === "user" && input.titleCandidate?.trim()
                ? { title: summarizeThreadTitle(input.titleCandidate) }
                : {}),
        })
        .where(and(eq(assistantThreads.id, input.threadId), eq(assistantThreads.userId, input.userId)))
}

/**
 * 编辑重提：按时间序只保留前 keepCount 条消息，删除其后全部（线性截断，无分支）。
 */
export async function truncateAssistantThreadMessages(input: {
    threadId: number
    keepCount: number
}): Promise<{ deleted: number }> {
    const keep = Math.max(0, Math.floor(input.keepCount))
    const rows = await getDb()
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, input.threadId))
        .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
    const toDelete = rows.slice(keep).map((row) => row.id)
    if (toDelete.length === 0) return { deleted: 0 }
    await getDb()
        .delete(assistantMessages)
        .where(inArray(assistantMessages.id, toDelete))
    return { deleted: toDelete.length }
}

export async function createAssistantRun(input: {
    threadId: number
    modelConfigId: number | null
    intentDomains: AgentDomainId[]
}) {
    const [created] = await getDb()
        .insert(assistantRuns)
        .values({
            threadId: input.threadId,
            status: "RUNNING",
            modelConfigId: input.modelConfigId,
            intentDomainsJson: JSON.stringify(input.intentDomains),
        })
        .returning({ id: assistantRuns.id })
    return created!
}

/** LLM 覆盖意图后回写 run 的域快照，保持审计与工具装载一致 */
export async function updateAssistantRunIntent(input: {
    runId: number
    intentDomains: AgentDomainId[]
}) {
    await getDb()
        .update(assistantRuns)
        .set({
            intentDomainsJson: JSON.stringify(input.intentDomains),
        })
        .where(eq(assistantRuns.id, input.runId))
}

export async function finishAssistantRun(input: {
    runId: number
    status: "COMPLETED" | "FAILED"
    errorCode?: string
}) {
    await getDb()
        .update(assistantRuns)
        .set({
            status: input.status,
            errorCode: input.errorCode ?? null,
            finishedAt: new Date(),
        })
        .where(eq(assistantRuns.id, input.runId))
}

export async function recordAssistantStep(input: {
    runId: number
    stepIndex: number
    toolName: string
    input: unknown
    output: unknown
    status: "COMPLETED" | "FAILED"
    errorCode?: string | null
    durationMs: number | null
}) {
    const safeInput = redactAssistantStepInput(input.input)
    await getDb().insert(assistantSteps).values({
        runId: input.runId,
        stepIndex: input.stepIndex,
        toolName: input.toolName,
        inputJson: safeInput === undefined ? null : JSON.stringify(safeInput),
        outputJson: input.output === undefined ? null : JSON.stringify(input.output),
        status: input.status,
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs,
    })
}

export async function listRecentToolNames(threadId: number): Promise<string[]> {
    const db = getDb()
    const [lastRun] = await db
        .select({ id: assistantRuns.id })
        .from(assistantRuns)
        .where(eq(assistantRuns.threadId, threadId))
        .orderBy(desc(assistantRuns.startedAt), desc(assistantRuns.id))
        .limit(1)
    if (!lastRun) return []
    const steps = await db
        .select({ toolName: assistantSteps.toolName })
        .from(assistantSteps)
        .where(eq(assistantSteps.runId, lastRun.id))
        .orderBy(asc(assistantSteps.stepIndex))
    return steps.map((step) => step.toolName)
}

/** 读取本线程上一轮 run 的意图域，供短确认延续写域装载 */
export async function listRecentIntentDomains(threadId: number): Promise<AgentDomainId[]> {
    const [lastRun] = await getDb()
        .select({ intentDomainsJson: assistantRuns.intentDomainsJson })
        .from(assistantRuns)
        .where(eq(assistantRuns.threadId, threadId))
        .orderBy(desc(assistantRuns.startedAt), desc(assistantRuns.id))
        .limit(1)
    if (!lastRun?.intentDomainsJson) return []
    try {
        const parsed = JSON.parse(lastRun.intentDomainsJson) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item): item is AgentDomainId => typeof item === "string")
    } catch {
        return []
    }
}

export async function listAssistantThreads(input: {
    userId: number
    cursor?: number
    limit?: number
    q?: string
}) {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
    const offset = input.cursor ?? 0
    const filters = [eq(assistantThreads.userId, input.userId), isNull(assistantThreads.deletedAt)]
    const keyword = input.q?.trim()
    if (keyword) {
        const pattern = `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        filters.push(like(assistantThreads.title, pattern))
    }
    const rows = await getDb()
        .select()
        .from(assistantThreads)
        .where(and(...filters))
        .orderBy(desc(assistantThreads.updatedAt), desc(assistantThreads.id))
        .limit(limit + 1)
        .offset(offset)
    const hasMore = rows.length > limit
    const sliced = hasMore ? rows.slice(0, limit) : rows
    return {
        items: sliced.map(toAssistantThreadResponse),
        nextCursor: hasMore ? offset + limit : null,
    }
}

export async function getAssistantThreadDetail(input: {
    userId: number
    threadId: number
    messageLimit?: number
}) {
    const thread = await loadAssistantThreadOrThrow(input.userId, input.threadId)
    const limit = Math.min(
        Math.max(input.messageLimit ?? ASSISTANT_THREAD_DETAIL_MESSAGE_LIMIT, 1),
        500,
    )
    // 取最近 N 条再按时间正序返回，避免长线程全量 hydrate
    const recentRows = await getDb()
        .select()
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, thread.id))
        .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
        .limit(limit)
    const messages = recentRows.reverse()
    return {
        thread: toAssistantThreadResponse(thread),
        messages: messages.map((message) => ({
            id: String(message.id),
            role: message.role,
            content: parseJsonValue(message.contentJson),
            createdAt: message.createdAt.toISOString(),
        })),
        plans: await listActiveAssistantPlans({
            userId: input.userId,
            threadId: thread.id,
        }),
        truncated: recentRows.length >= limit,
    }
}

export async function softDeleteAssistantThread(input: { userId: number; threadId: number }) {
    const thread = await loadAssistantThreadOrThrow(input.userId, input.threadId)
    await getDb()
        .update(assistantThreads)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(assistantThreads.id, thread.id))
    return { ok: true as const }
}

export async function softDeleteAssistantThreads(userId: number, threadIds: number[]) {
    if (threadIds.length === 0) return { deleted: 0 }
    const uniqueIds = Array.from(new Set(threadIds))
    const rows = await getDb()
        .update(assistantThreads)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(
            eq(assistantThreads.userId, userId),
            inArray(assistantThreads.id, uniqueIds),
            isNull(assistantThreads.deletedAt),
        ))
        .returning({ id: assistantThreads.id })
    return { deleted: rows.length }
}

function parseJsonValue(value: string | null): unknown {
    if (!value) return null
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}
