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
    MAX_REFLECTED,
    MEMORY_MERGE_MAX_DISTANCE,
    REFLECT_TRIGGER_ACTIVE_COUNT,
    agentMemoryDeleteInputSchema,
    buildMemoryPromptSection,
    buildObserverSystemPrompt,
    buildObserverUserMessage,
    buildReflectorSystemPrompt,
    buildReflectorUserMessage,
    normalizeMemoryContent,
    parseDistilledMemories,
    shouldDistillAgentMemory,
    type ConversationTurn,
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

    // Observer 观察完整对话（提问 + 回答），而不只是提问，观察更稠密、更贴近真实语境。
    const sliceRows = await db
        .select({
            id: knowledgeBaseAgentMessages.id,
            role: knowledgeBaseAgentMessages.role,
            contentText: knowledgeBaseAgentMessages.contentText,
        })
        .from(knowledgeBaseAgentMessages)
        .where(and(
            eq(knowledgeBaseAgentMessages.userId, userId),
            gt(knowledgeBaseAgentMessages.id, lastMessageId),
        ))
        .orderBy(asc(knowledgeBaseAgentMessages.id))
        .limit(DISTILL_MESSAGE_SAMPLE_LIMIT)
    const turns: ConversationTurn[] = sliceRows
        .map((row) => ({
            role: row.role === "assistant" ? "assistant" as const : "user" as const,
            text: (row.contentText ?? "").trim(),
        }))
        .filter((turn) => turn.text)
    if (turns.length === 0) {
        return { status: "no_new_messages", created: 0, merged: 0, sampledQuestions: 0 }
    }
    const consumedMaxId = sliceRows[sliceRows.length - 1].id
    const sampledQuestions = turns.filter((turn) => turn.role === "user").length

    // 先推进水位再观察：并发请求下最多丢一轮样本，绝不会重复观察同一批消息
    await upsertMemoryState(db, {
        userId,
        lastDistilledAt: now,
        lastMessageId: consumedMaxId,
        distillCount: (state?.distillCount ?? 0) + 1,
    })

    const ingest = await ingestObservedConversationTurns({ userId, turns })
    return {
        status: ingest.status,
        created: ingest.created,
        merged: ingest.merged,
        sampledQuestions,
    }
}

/** 供站内 Assistant 等入口复用：对给定对话轮次跑 Observer → 合并 → Reflector → 上限裁剪 */
export async function ingestObservedConversationTurns(input: {
    userId: number
    turns: ConversationTurn[]
}): Promise<{
    status: "distilled" | "nothing_to_keep"
    created: number
    merged: number
    sampledQuestions: number
}> {
    const { userId, turns } = input
    const sampledQuestions = turns.filter((turn) => turn.role === "user").length
    if (turns.length === 0) {
        return { status: "nothing_to_keep", created: 0, merged: 0, sampledQuestions: 0 }
    }

    const now = new Date()
    const db = getDb()
    const completion = await callChatCompletion({
        userId,
        systemPrompt: buildObserverSystemPrompt(),
        message: buildObserverUserMessage(turns),
    })
    const observed = parseDistilledMemories(completion.answer)
    if (observed.length === 0) {
        return { status: "nothing_to_keep", created: 0, merged: 0, sampledQuestions }
    }

    const mergeResult = await mergeDistilledMemories({ db, userId, distilled: observed, now })
    await reflectMemoryLog(db, userId, now)
    await enforceMemoryCap(db, userId)
    return {
        status: "distilled",
        created: mergeResult.created,
        merged: mergeResult.merged,
        sampledQuestions,
    }
}

// Reflector（对标 Mastra OM 的反思器）：活跃观察超过阈值时，请模型对全量日志做一次
// 「合并相关 + 删除过时 + 抽象共性 + 压缩」重构，并在单个事务里原子替换旧日志。
// 任何异常都被吞掉且事务回滚，保证不影响问答主流程、也不会因半途失败而丢记忆。
async function reflectMemoryLog(db: Db, userId: number, now: Date): Promise<void> {
    try {
        const active = await db
            .select({ id: agentMemories.id, kind: agentMemories.kind, content: agentMemories.content })
            .from(agentMemories)
            .where(eq(agentMemories.userId, userId))
            .orderBy(desc(agentMemories.evidenceCount), desc(agentMemories.lastSeenAt))
        if (active.length <= REFLECT_TRIGGER_ACTIVE_COUNT) return

        const completion = await callChatCompletion({
            userId,
            systemPrompt: buildReflectorSystemPrompt(),
            message: buildReflectorUserMessage(active),
        })
        const condensed = parseDistilledMemories(completion.answer, MAX_REFLECTED)
        // 安全护栏：必须确实压缩（少于原数量）又不能塌缩过头（至少保留 40%），否则放弃本次反思。
        const floor = Math.max(1, Math.ceil(active.length * 0.4))
        if (condensed.length < floor || condensed.length >= active.length) return

        const vectorReady = !isSqliteDatabase() && await hasEmbeddingConfig(userId).catch(() => false)
        const embeddings = vectorReady
            ? await embedTexts(userId, condensed.map((item) => item.content)).catch(() => null)
            : null

        const insertedIds = await db.transaction(async (tx) => {
            await tx.delete(agentMemories).where(eq(agentMemories.userId, userId))
            const ids: number[] = []
            for (const item of condensed) {
                const [inserted] = await tx
                    .insert(agentMemories)
                    .values({
                        userId,
                        kind: item.kind,
                        content: item.content,
                        // 反思后的观察是被语料反复印证的综合，给一个 >1 的证据基线。
                        evidenceCount: 2,
                        lastSeenAt: now,
                    })
                    .returning({ id: agentMemories.id })
                ids.push(inserted.id)
            }
            return ids
        })

        // 向量重建放在事务提交后、best-effort：失败只降级为精确去重，不影响记忆本身。
        if (embeddings) {
            for (const [index, id] of insertedIds.entries()) {
                const embedding = embeddings[index]
                if (embedding) await writeMemoryEmbedding(db, id, embedding)
            }
        }
    } catch (error) {
        console.warn("[AgentMemory] 观察日志反思失败（已跳过，保留原有记忆）", error)
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
    lastMessageId?: number
    lastAssistantMessageId?: number
    distillCount: number
}) {
    const [existing] = await db
        .select()
        .from(agentMemoryStates)
        .where(eq(agentMemoryStates.userId, input.userId))
        .limit(1)
    const lastMessageId = input.lastMessageId ?? existing?.lastMessageId ?? 0
    const lastAssistantMessageId = input.lastAssistantMessageId ?? existing?.lastAssistantMessageId ?? 0
    await db
        .insert(agentMemoryStates)
        .values({
            userId: input.userId,
            lastDistilledAt: input.lastDistilledAt,
            lastMessageId,
            lastAssistantMessageId,
            distillCount: input.distillCount,
            updatedAt: input.lastDistilledAt,
        })
        .onConflictDoUpdate({
            target: agentMemoryStates.userId,
            set: {
                lastDistilledAt: input.lastDistilledAt,
                lastMessageId,
                lastAssistantMessageId,
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
