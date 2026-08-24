import { asc, eq, sql } from "drizzle-orm"
import { createLogger, toLogError } from "@/lib/logger"
import { embedQuery, embedTexts, hasEmbeddingConfig } from "@/server/ai/embedding"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { assistantMessages } from "@/server/db/schema"
import { cosineDistance, cosineSimilarity, whereSameDimension } from "@/server/retrieval/vector-space"
import { extractMessagePlainText } from "./message-text"

const log = createLogger("assistant-context-recall")

export const CONTEXT_RECALL_TOP_K = 4
export const CONTEXT_RECALL_MIN_SCORE = 0.25
export const CONTEXT_RECALL_EMBED_BATCH = 16
export const CONTEXT_RECALL_EXCERPT_MAX = 500

export type RecalledSnippet = {
    messageId: string
    score: number
    excerpt: string
}

/** @deprecated 使用 extractMessagePlainText；保留别名兼容 */
export function extractPlainTextForRecall(message: unknown): string {
    return extractMessagePlainText(message)
}

/** 去掉密钥/确认明文等，避免写入召回摘要。 */
export function sanitizeRecallExcerpt(text: string): string {
    let next = text
        .replace(/sk-[a-zA-Z0-9]{10,}/g, "[redacted]")
        .replace(/(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]")
        .replace(/executionOutcome[\s\S]{0,200}/gi, "[confirmation omitted]")
    next = next.replace(/\s+/g, " ").trim()
    if (next.length <= CONTEXT_RECALL_EXCERPT_MAX) return next
    return `${next.slice(0, CONTEXT_RECALL_EXCERPT_MAX)}…`
}

export function buildInstructionsWithContextExtras(
    basePrompt: string,
    summaryMd: string | null,
    recalledSnippets?: RecalledSnippet[] | null,
): string {
    const parts = [basePrompt]
    if (summaryMd?.trim()) {
        parts.push(
            "",
            "以下是本对话较早内容的摘要（已折叠细节，仅供连贯理解；最近几轮原文仍在消息中）：",
            summaryMd.trim(),
        )
    }
    if (recalledSnippets?.length) {
        parts.push(
            "",
            "以下是与当前问题相关的较早对话片段（向量召回，供参考，非完整历史）：",
            ...recalledSnippets.map((item, index) =>
                `${index + 1}. (相关度 ${item.score.toFixed(2)}) ${item.excerpt}`),
        )
    }
    return parts.join("\n")
}

export async function recallRelevantHistory(input: {
    userId: number
    threadId: number
    query: string
    excludeMessageIds: number[]
    limit?: number
}): Promise<RecalledSnippet[]> {
    const query = input.query.trim()
    if (!query) return []
    if (isSqliteDatabase()) return []
    try {
        if (!(await hasEmbeddingConfig(input.userId))) return []

        // 热路径只读已有 embedding；缺向量时后台异步补齐，不阻塞本轮召回
        void ensureThreadMessageEmbeddingsBestEffort({
            userId: input.userId,
            threadId: input.threadId,
            excludeMessageIds: input.excludeMessageIds,
        }).catch((error) => {
            log.warn({
                err: toLogError(error),
                userId: input.userId,
                threadId: input.threadId,
            }, "后台补齐消息向量失败")
        })

        const vector = await embedQuery(input.userId, query.slice(0, 4_000))
        if (!vector?.length) return []
        const literal = `[${vector.join(",")}]`
        // 该表没有维度元数据列，按当前向量的实际长度过滤，避免跨维度比较报错
        const dims = vector.length
        const limit = input.limit ?? CONTEXT_RECALL_TOP_K
        const exclude = input.excludeMessageIds.filter((id) => Number.isFinite(id))

        const rows = exclude.length > 0
            ? await getDb().execute(sql`
                select message_id, excerpt_md,
                    (${cosineSimilarity("embedding", literal, dims)})::float8 as score
                from petrichor_assistant_message_embedding
                where thread_id = ${input.threadId}
                  and user_id = ${input.userId}
                  and embedding is not null
                  and ${whereSameDimension("embedding", dims)}
                  and message_id not in (${sql.join(exclude.map((id) => sql`${id}`), sql`, `)})
                order by ${cosineDistance("embedding", literal, dims)}
                limit ${limit}
            `)
            : await getDb().execute(sql`
                select message_id, excerpt_md,
                    (${cosineSimilarity("embedding", literal, dims)})::float8 as score
                from petrichor_assistant_message_embedding
                where thread_id = ${input.threadId}
                  and user_id = ${input.userId}
                  and embedding is not null
                  and ${whereSameDimension("embedding", dims)}
                order by ${cosineDistance("embedding", literal, dims)}
                limit ${limit}
            `)

        const snippets: RecalledSnippet[] = []
        for (const row of rows as unknown as Array<Record<string, unknown>>) {
            const messageId = Number(row.message_id)
            const score = Number(row.score)
            const excerpt = typeof row.excerpt_md === "string" ? row.excerpt_md.trim() : ""
            if (!Number.isFinite(messageId) || !excerpt) continue
            if (!Number.isFinite(score) || score < CONTEXT_RECALL_MIN_SCORE) continue
            snippets.push({
                messageId: String(messageId),
                score,
                excerpt,
            })
        }
        return snippets
    } catch (error) {
        log.warn({
            err: toLogError(error),
            userId: input.userId,
            threadId: input.threadId,
        }, "上下文向量召回失败，跳过本路召回")
        return []
    }
}

async function ensureThreadMessageEmbeddingsBestEffort(input: {
    userId: number
    threadId: number
    excludeMessageIds: number[]
}) {
    const exclude = new Set(input.excludeMessageIds)
    const messages = await getDb()
        .select({
            id: assistantMessages.id,
            role: assistantMessages.role,
            contentJson: assistantMessages.contentJson,
        })
        .from(assistantMessages)
        .where(eq(assistantMessages.threadId, input.threadId))
        .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
        .limit(200)

    const candidates = messages
        .filter((row) => !exclude.has(row.id))
        .map((row) => {
            let content: unknown = null
            try {
                content = row.contentJson ? JSON.parse(row.contentJson) : null
            } catch {
                content = row.contentJson
            }
            const excerpt = sanitizeRecallExcerpt(extractPlainTextForRecall({
                role: row.role,
                ...(content && typeof content === "object" ? content as object : { content }),
            }))
            return { id: row.id, excerpt }
        })
        .filter((row) => row.excerpt.length >= 8)

    if (candidates.length === 0) return

    const existing = await getDb().execute(sql`
        select message_id
        from petrichor_assistant_message_embedding
        where thread_id = ${input.threadId}
          and user_id = ${input.userId}
    `)
    const embeddedIds = new Set(
        [...(existing as unknown as Array<Record<string, unknown>>)]
            .map((row) => Number(row.message_id))
            .filter((id) => Number.isFinite(id)),
    )

    const pending = candidates
        .filter((row) => !embeddedIds.has(row.id))
        .slice(0, CONTEXT_RECALL_EMBED_BATCH)
    if (pending.length === 0) return

    const vectors = await embedTexts(input.userId, pending.map((row) => row.excerpt))
    for (let i = 0; i < pending.length; i += 1) {
        const vector = vectors[i]
        const row = pending[i]
        if (!vector || !row) continue
        const literal = `[${vector.join(",")}]`
        await getDb().execute(sql`
            insert into petrichor_assistant_message_embedding
                (message_id, thread_id, user_id, excerpt_md, embedding, created_at)
            values
                (${row.id}, ${input.threadId}, ${input.userId}, ${row.excerpt}, ${literal}::vector, now())
            on conflict (message_id) do update set
                excerpt_md = excluded.excerpt_md,
                embedding = excluded.embedding
        `)
    }
}
