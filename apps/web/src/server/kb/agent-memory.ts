// Agent 跨 thread 长期记忆：从已持久化的问答消息中蒸馏用户偏好/常关注主题，
// 与既有记忆做（向量）去重合并，供问答 Agent 注入 system prompt。
// 蒸馏在响应结束后异步执行且严格限频，任何失败只记日志、绝不影响问答主流程。
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { callChatCompletion } from "@/server/ai/generation"
import { embedTexts, hasEmbeddingConfig } from "@/server/ai/embedding"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import {
    agentMemories,
    agentMemoryStates,
    knowledgeBaseAgentMessages,
    type AgentMemoryRecord,
} from "@/server/db/schema"
import { notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    DISTILL_MESSAGE_SAMPLE_LIMIT,
    MAX_ACTIVE_MEMORIES,
    MAX_PROMPT_MEMORIES,
    MEMORY_MERGE_MAX_DISTANCE,
    agentMemoryDeleteInputSchema,
    buildMemoryDistillSystemPrompt,
    buildMemoryDistillUserMessage,
    buildMemoryPromptSection,
    normalizeMemoryContent,
    parseDistilledMemories,
    shouldDistillAgentMemory,
    type DistilledMemory,
} from "./agent-memory-logic"

type Db = ReturnType<typeof getDb>

// ===== 注入 system prompt =====

export async function loadAgentMemoryPromptSection(userId: number): Promise<string | null> {
    try {
        const rows = await getDb()
            .select({ kind: agentMemories.kind, content: agentMemories.content })
            .from(agentMemories)
            .where(eq(agentMemories.userId, userId))
            .orderBy(desc(agentMemories.evidenceCount), desc(agentMemories.lastSeenAt))
            .limit(MAX_PROMPT_MEMORIES)
        return buildMemoryPromptSection(rows)
    } catch (error) {
        console.warn("[AgentMemory] 加载长期记忆失败，本次不注入", error)
        return null
    }
}

// ===== 蒸馏管道（响应后异步触发；也可从管理界面强制触发） =====

export interface DistillRunResult {
    status: "distilled" | "skipped" | "no_new_messages" | "nothing_to_keep"
    created: number
    merged: number
    sampledQuestions: number
}

export async function maybeDistillAgentMemory(userId: number): Promise<void> {
    try {
        await runAgentMemoryDistillation(userId, { force: false })
    } catch (error) {
        console.warn("[AgentMemory] 记忆蒸馏失败（已跳过，不影响问答）", error)
    }
}

export async function runAgentMemoryDistillation(
    userId: number,
    options: { force: boolean },
): Promise<DistillRunResult> {
    const now = new Date()
    const db = getDb()

    const [state] = await db
        .select()
        .from(agentMemoryStates)
        .where(eq(agentMemoryStates.userId, userId))
        .limit(1)
    const lastMessageId = state?.lastMessageId ?? 0

    const newMessagesWhere = and(
        eq(knowledgeBaseAgentMessages.userId, userId),
        eq(knowledgeBaseAgentMessages.role, "user"),
        gt(knowledgeBaseAgentMessages.id, lastMessageId),
    )
    const [countRow] = await db
        .select({ total: count() })
        .from(knowledgeBaseAgentMessages)
        .where(newMessagesWhere)
    const newUserMessageCount = Number(countRow?.total ?? 0)

    if (newUserMessageCount === 0) {
        return { status: "no_new_messages", created: 0, merged: 0, sampledQuestions: 0 }
    }
    if (!options.force && !shouldDistillAgentMemory({
        lastDistilledAt: toDateOrNull(state?.lastDistilledAt),
        newUserMessageCount,
        now,
    })) {
        return { status: "skipped", created: 0, merged: 0, sampledQuestions: 0 }
    }

    const messages = await db
        .select({
            id: knowledgeBaseAgentMessages.id,
            contentText: knowledgeBaseAgentMessages.contentText,
        })
        .from(knowledgeBaseAgentMessages)
        .where(newMessagesWhere)
        .orderBy(asc(knowledgeBaseAgentMessages.id))
        .limit(DISTILL_MESSAGE_SAMPLE_LIMIT)
    const questions = messages
        .map((message) => message.contentText.trim())
        .filter(Boolean)
    if (questions.length === 0) {
        return { status: "no_new_messages", created: 0, merged: 0, sampledQuestions: 0 }
    }
    const consumedMaxId = messages[messages.length - 1].id

    // 先推进水位再蒸馏：并发请求下最多丢一轮样本，绝不会重复蒸馏同一批消息
    await upsertMemoryState(db, {
        userId,
        lastDistilledAt: now,
        lastMessageId: consumedMaxId,
        distillCount: (state?.distillCount ?? 0) + 1,
    })

    const completion = await callChatCompletion({
        userId,
        systemPrompt: buildMemoryDistillSystemPrompt(),
        message: buildMemoryDistillUserMessage(questions),
    })
    const distilled = parseDistilledMemories(completion.answer)
    if (distilled.length === 0) {
        return { status: "nothing_to_keep", created: 0, merged: 0, sampledQuestions: questions.length }
    }

    const mergeResult = await mergeDistilledMemories({ db, userId, distilled, now })
    await enforceMemoryCap(db, userId)
    return {
        status: "distilled",
        created: mergeResult.created,
        merged: mergeResult.merged,
        sampledQuestions: questions.length,
    }
}

// 新蒸馏条目并入既有记忆：精确归一化去重 → 向量语义去重 → 插入新记忆
async function mergeDistilledMemories(input: {
    db: Db
    userId: number
    distilled: DistilledMemory[]
    now: Date
}): Promise<{ created: number; merged: number }> {
    const { db, userId, distilled, now } = input
    let created = 0
    let merged = 0

    const existing = await db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.userId, userId))
    const existingByKey = new Map(existing.map((memory) => [normalizeMemoryContent(memory.content), memory]))

    const vectorReady = !isSqliteDatabase() && await hasEmbeddingConfig(userId).catch(() => false)
    const embeddings = vectorReady
        ? await embedTexts(userId, distilled.map((item) => item.content)).catch(() => null)
        : null

    for (const [index, item] of distilled.entries()) {
        const exactMatch = existingByKey.get(normalizeMemoryContent(item.content))
        if (exactMatch) {
            await bumpMemory(db, exactMatch, now)
            merged += 1
            continue
        }

        const embedding = embeddings?.[index] ?? null
        if (embedding) {
            const similarId = await findSimilarMemoryId(db, userId, embedding)
            if (similarId != null) {
                const similar = existing.find((memory) => memory.id === similarId)
                if (similar) {
                    await bumpMemory(db, similar, now)
                    merged += 1
                    continue
                }
            }
        }

        const [inserted] = await db
            .insert(agentMemories)
            .values({
                userId,
                kind: item.kind,
                content: item.content,
                evidenceCount: 1,
                lastSeenAt: now,
            })
            .returning()
        existingByKey.set(normalizeMemoryContent(item.content), inserted)
        created += 1
        if (embedding) {
            await writeMemoryEmbedding(db, inserted.id, embedding)
        }
    }

    return { created, merged }
}

async function bumpMemory(db: Db, memory: AgentMemoryRecord, now: Date) {
    await db
        .update(agentMemories)
        .set({
            evidenceCount: memory.evidenceCount + 1,
            lastSeenAt: now,
            updatedAt: now,
        })
        .where(eq(agentMemories.id, memory.id))
}

async function findSimilarMemoryId(db: Db, userId: number, embedding: number[]): Promise<number | null> {
    try {
        const literal = `[${embedding.join(",")}]`
        const rows = await db.execute(sql`
            select id, embedding <=> ${literal}::vector as distance
            from petrichor_agent_memory
            where user_id = ${userId} and embedding is not null
            order by embedding <=> ${literal}::vector
            limit 1
        `)
        for (const raw of rows as Iterable<Record<string, unknown>>) {
            const distance = Number(raw.distance)
            if (Number.isFinite(distance) && distance < MEMORY_MERGE_MAX_DISTANCE) {
                return Number(raw.id)
            }
            return null
        }
        return null
    } catch {
        return null
    }
}

async function writeMemoryEmbedding(db: Db, memoryId: number, embedding: number[]) {
    try {
        const literal = `[${embedding.join(",")}]`
        await db.execute(sql`
            update petrichor_agent_memory
            set embedding = ${literal}::vector
            where id = ${memoryId}
        `)
    } catch (error) {
        console.warn("[AgentMemory] 记忆向量写入失败（记忆仍有效，仅降级为精确去重）", error)
    }
}

// 记忆总量上限：淘汰证据最少、最久未出现的
async function enforceMemoryCap(db: Db, userId: number) {
    const rows = await db
        .select({ id: agentMemories.id })
        .from(agentMemories)
        .where(eq(agentMemories.userId, userId))
        .orderBy(desc(agentMemories.evidenceCount), desc(agentMemories.lastSeenAt))
    const overflow = rows.slice(MAX_ACTIVE_MEMORIES).map((row) => row.id)
    for (const id of overflow) {
        await db.delete(agentMemories).where(and(
            eq(agentMemories.id, id),
            eq(agentMemories.userId, userId),
        ))
    }
}

async function upsertMemoryState(db: Db, input: {
    userId: number
    lastDistilledAt: Date
    lastMessageId: number
    distillCount: number
}) {
    await db
        .insert(agentMemoryStates)
        .values({
            userId: input.userId,
            lastDistilledAt: input.lastDistilledAt,
            lastMessageId: input.lastMessageId,
            distillCount: input.distillCount,
            updatedAt: input.lastDistilledAt,
        })
        .onConflictDoUpdate({
            target: agentMemoryStates.userId,
            set: {
                lastDistilledAt: input.lastDistilledAt,
                lastMessageId: input.lastMessageId,
                distillCount: input.distillCount,
                updatedAt: input.lastDistilledAt,
            },
        })
}

// ===== 管理接口（查看 / 删除记忆） =====

export async function listAgentMemories(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const db = getDb()
        const rows = await db
            .select()
            .from(agentMemories)
            .where(eq(agentMemories.userId, user.id))
            .orderBy(desc(agentMemories.evidenceCount), desc(agentMemories.lastSeenAt))

        const [state] = await db
            .select()
            .from(agentMemoryStates)
            .where(eq(agentMemoryStates.userId, user.id))
            .limit(1)
        const [pendingRow] = await db
            .select({ total: count() })
            .from(knowledgeBaseAgentMessages)
            .where(and(
                eq(knowledgeBaseAgentMessages.userId, user.id),
                eq(knowledgeBaseAgentMessages.role, "user"),
                gt(knowledgeBaseAgentMessages.id, state?.lastMessageId ?? 0),
            ))

        return ok({
            items: rows.map((memory) => ({
                id: String(memory.id),
                kind: memory.kind,
                content: memory.content,
                evidenceCount: memory.evidenceCount,
                lastSeenAt: toIsoString(memory.lastSeenAt),
                createdAt: toIsoString(memory.createdAt),
            })),
            state: {
                lastDistilledAt: state?.lastDistilledAt ? toIsoString(state.lastDistilledAt) : null,
                distillCount: state?.distillCount ?? 0,
                pendingMessageCount: Number(pendingRow?.total ?? 0),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function distillAgentMemoryNow(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const result = await runAgentMemoryDistillation(user.id, { force: true })
        return ok(result)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function deleteAgentMemory(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = agentMemoryDeleteInputSchema.parse(await readJson(request))
        const [deleted] = await getDb()
            .delete(agentMemories)
            .where(and(
                eq(agentMemories.id, input.memoryId),
                eq(agentMemories.userId, user.id),
            ))
            .returning()
        if (!deleted) {
            throw notFound("记忆不存在")
        }
        return ok({ memoryId: String(deleted.id), deleted: true })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
    if (!value) return null
    return value instanceof Date ? value : new Date(value)
}

function toIsoString(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
