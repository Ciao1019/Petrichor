import { and, asc, desc, eq, inArray, isNull, like } from "drizzle-orm"
import { z } from "zod"
import { getDb } from "@/server/db/client"
import {
    docQaArtifacts,
    docQaMessages,
    docQaRuns,
    docQaSteps,
    docQaThreads,
} from "@/server/db/schema"
import { notFound } from "@/server/http/response"
import { idSchema } from "./library-logic"

export { idSchema }

export const docQaThreadListSchema = z.object({
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(100).optional(),
    q: z.string().trim().max(120).optional(),
    libraryId: z.union([z.string(), z.number()]).optional(),
    scope: z.enum(["cross"]).optional(),
})

export const docQaThreadDeleteManySchema = z.object({
    threadIds: z.array(idSchema).min(1).max(200),
})

export async function ensureDocQaThread(input: {
    userId: number
    threadId: number | null
    libraryId: number | null
    title: string
}) {
    if (input.threadId != null) {
        return await loadThreadOrThrow(input.userId, input.threadId)
    }
    const db = getDb()
    const now = new Date()
    const [created] = await db
        .insert(docQaThreads)
        .values({
            userId: input.userId,
            libraryId: input.libraryId,
            title: summarizePlainText(input.title || "文档问答", 40),
            status: "ACTIVE",
            lastMessageAt: now,
            createdAt: now,
            updatedAt: now,
        })
        .returning({ id: docQaThreads.id })
    return await loadThreadOrThrow(input.userId, created!.id)
}

export async function createDocQaRun(input: { userId: number; threadId: number; modelName: string }) {
    const [created] = await getDb()
        .insert(docQaRuns)
        .values({ userId: input.userId, threadId: input.threadId, status: "RUNNING", modelName: input.modelName })
        .returning({ id: docQaRuns.id })
    return created!
}

export async function finishDocQaRun(input: {
    runId: number
    userId: number
    status: "COMPLETED" | "FAILED"
    errorMessage?: string
}) {
    await getDb()
        .update(docQaRuns)
        .set({ status: input.status, errorMessage: input.errorMessage, finishedAt: new Date() })
        .where(and(eq(docQaRuns.id, input.runId), eq(docQaRuns.userId, input.userId)))
}

export async function persistDocQaMessage(input: {
    userId: number
    threadId: number
    role: "user" | "assistant"
    contentText: string
    content: unknown
}) {
    const db = getDb()
    const now = new Date()
    await db.insert(docQaMessages).values({
        userId: input.userId,
        threadId: input.threadId,
        role: input.role,
        contentText: input.contentText,
        contentJson: JSON.stringify(input.content),
        createdAt: now,
    })
    await db
        .update(docQaThreads)
        .set({
            lastMessageAt: now,
            updatedAt: now,
            ...(input.role === "user" && input.contentText.trim()
                ? { title: summarizePlainText(input.contentText, 40) }
                : {}),
        })
        .where(and(eq(docQaThreads.id, input.threadId), eq(docQaThreads.userId, input.userId)))
}

export async function recordDocQaStep(input: {
    runId: number
    userId: number
    stepType: string
    title: string
    status: string
    payload?: unknown
}) {
    await getDb().insert(docQaSteps).values({
        runId: input.runId,
        userId: input.userId,
        stepType: input.stepType,
        title: input.title,
        status: input.status,
        payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    })
}

export async function createDocQaArtifact(input: {
    userId: number
    threadId: number
    runId: number
    artifactType: string
    title: string
    contentMd?: string
    payload?: unknown
}) {
    const [created] = await getDb()
        .insert(docQaArtifacts)
        .values({
            userId: input.userId,
            threadId: input.threadId,
            runId: input.runId,
            artifactType: input.artifactType,
            title: input.title,
            contentMd: input.contentMd,
            payloadJson: input.payload ? JSON.stringify(input.payload) : null,
        })
        .returning({ id: docQaArtifacts.id })
    return { id: created!.id }
}

export async function listDocQaThreads(input: {
    userId: number
    limit?: number
    cursor?: number
    query?: string
    libraryId?: number | null
    scope?: "cross"
}) {
    const db = getDb()
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
    const offset = input.cursor ?? 0
    const filters = [eq(docQaThreads.userId, input.userId)]
    if (input.scope === "cross") filters.push(isNull(docQaThreads.libraryId))
    else if (input.libraryId != null) filters.push(eq(docQaThreads.libraryId, input.libraryId))
    const keyword = input.query?.trim()
    if (keyword) {
        const pattern = `%${keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        filters.push(like(docQaThreads.title, pattern))
    }
    const rows = await db
        .select()
        .from(docQaThreads)
        .where(and(...filters))
        .orderBy(desc(docQaThreads.updatedAt), desc(docQaThreads.id))
        .limit(limit + 1)
        .offset(offset)
    const hasMore = rows.length > limit
    const sliced = hasMore ? rows.slice(0, limit) : rows
    return {
        threads: sliced.map(toThreadResponse),
        nextCursor: hasMore ? offset + limit : null,
    }
}

export async function getDocQaThreadDetail(input: { userId: number; threadId: number }) {
    const thread = await loadThreadOrThrow(input.userId, input.threadId)
    const messages = await getDb()
        .select({
            id: docQaMessages.id,
            role: docQaMessages.role,
            contentText: docQaMessages.contentText,
            contentJson: docQaMessages.contentJson,
            metadataJson: docQaMessages.metadataJson,
            createdAt: docQaMessages.createdAt,
        })
        .from(docQaMessages)
        .where(eq(docQaMessages.threadId, input.threadId))
        .orderBy(asc(docQaMessages.createdAt), asc(docQaMessages.id))
    return {
        thread: toThreadResponse(thread),
        messages: messages.map((m) => ({
            id: String(m.id),
            role: m.role,
            contentText: m.contentText,
            content: parseJsonObject(m.contentJson),
            metadata: parseJsonObject(m.metadataJson),
            createdAt: m.createdAt.toISOString(),
        })),
    }
}

export async function deleteDocQaThread(input: { userId: number; threadId: number }) {
    const db = getDb()
    const thread = await loadThreadOrThrow(input.userId, input.threadId)
    await db.transaction(async (tx) => {
        await tx.delete(docQaMessages).where(eq(docQaMessages.threadId, thread.id))
        await tx.delete(docQaArtifacts).where(eq(docQaArtifacts.threadId, thread.id))
        const runs = await tx.select({ id: docQaRuns.id }).from(docQaRuns).where(eq(docQaRuns.threadId, thread.id))
        const runIds = runs.map((r) => r.id)
        if (runIds.length > 0) {
            await tx.delete(docQaSteps).where(inArray(docQaSteps.runId, runIds))
            await tx.delete(docQaRuns).where(inArray(docQaRuns.id, runIds))
        }
        await tx.delete(docQaThreads).where(and(eq(docQaThreads.id, thread.id), eq(docQaThreads.userId, input.userId)))
    })
    return { id: String(thread.id) }
}

export async function deleteDocQaThreads(userId: number, threadIds: number[]) {
    if (threadIds.length === 0) return { deleted: [] as string[], failed: [] as Array<{ id: string; reason: string }> }
    const db = getDb()
    const uniqueIds = Array.from(new Set(threadIds))
    const ownedRows = await db
        .select({ id: docQaThreads.id })
        .from(docQaThreads)
        .where(and(eq(docQaThreads.userId, userId), inArray(docQaThreads.id, uniqueIds)))
    const ownedIds = ownedRows.map((r) => r.id)
    const ownedSet = new Set(ownedIds.map((id) => String(id)))
    const failed = uniqueIds.filter((id) => !ownedSet.has(String(id))).map((id) => ({ id: String(id), reason: "对话不存在或无权限" }))
    if (ownedIds.length === 0) return { deleted: [], failed }
    await db.transaction(async (tx) => {
        const runs = await tx.select({ id: docQaRuns.id }).from(docQaRuns).where(inArray(docQaRuns.threadId, ownedIds))
        const runIds = runs.map((r) => r.id)
        if (runIds.length > 0) await tx.delete(docQaSteps).where(inArray(docQaSteps.runId, runIds))
        await tx.delete(docQaMessages).where(inArray(docQaMessages.threadId, ownedIds))
        if (runIds.length > 0) await tx.delete(docQaRuns).where(inArray(docQaRuns.id, runIds))
        await tx.delete(docQaArtifacts).where(inArray(docQaArtifacts.threadId, ownedIds))
        await tx.delete(docQaThreads).where(and(eq(docQaThreads.userId, userId), inArray(docQaThreads.id, ownedIds)))
    })
    return { deleted: ownedIds.map((id) => String(id)), failed }
}

async function loadThreadOrThrow(userId: number, threadId: number) {
    const [thread] = await getDb()
        .select()
        .from(docQaThreads)
        .where(and(eq(docQaThreads.id, threadId), eq(docQaThreads.userId, userId)))
        .limit(1)
    if (!thread) throw notFound("对话不存在")
    return thread
}

function toThreadResponse(thread: typeof docQaThreads.$inferSelect) {
    return {
        id: String(thread.id),
        libraryId: thread.libraryId != null ? String(thread.libraryId) : null,
        title: thread.title,
        status: thread.status,
        lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
        metadata: parseJsonObject(thread.metadataJson),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
    }
}

function parseJsonObject(value: string | null | undefined) {
    if (!value) return null
    try {
        const parsed = JSON.parse(value) as unknown
        return typeof parsed === "object" && parsed !== null ? parsed : null
    } catch {
        return null
    }
}

function summarizePlainText(text: string, maxLength: number) {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (!normalized) return "文档问答"
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, maxLength - 1)}…`
}
