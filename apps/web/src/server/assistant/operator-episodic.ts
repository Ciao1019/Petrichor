import { sql } from "drizzle-orm"
import { embedQuery, hasEmbeddingConfig } from "@/server/ai/embedding"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { cosineDistance, cosineSimilarity, whereSameDimension } from "@/server/retrieval/vector-space"
import { CONTEXT_RECALL_MIN_SCORE, sanitizeRecallExcerpt } from "./context-recall"

export type OperatorHistoryHit = {
    threadId: string
    messageId: string
    excerpt: string
    score: number
    source: "keyword" | "semantic"
}

export async function searchOperatorHistoryFts(input: {
    userId: number
    query: string
    limit: number
    excludeThreadId?: number | null
}): Promise<OperatorHistoryHit[]> {
    const query = input.query.trim()
    if (!query) return []
    if (isSqliteDatabase()) {
        return searchOperatorHistoryIlikeFallback(input)
    }
    try {
        const exclude = input.excludeThreadId
        const rows = exclude
            ? await getDb().execute(sql`
                select e.thread_id, e.message_id, e.excerpt_md,
                    ts_rank(
                        to_tsvector('simple', coalesce(e.excerpt_md, '')),
                        plainto_tsquery('simple', ${query})
                    )::float8 as score
                from petrichor_assistant_message_embedding e
                where e.user_id = ${input.userId}
                  and e.thread_id <> ${exclude}
                  and to_tsvector('simple', coalesce(e.excerpt_md, ''))
                      @@ plainto_tsquery('simple', ${query})
                order by score desc
                limit ${input.limit}
            `)
            : await getDb().execute(sql`
                select e.thread_id, e.message_id, e.excerpt_md,
                    ts_rank(
                        to_tsvector('simple', coalesce(e.excerpt_md, '')),
                        plainto_tsquery('simple', ${query})
                    )::float8 as score
                from petrichor_assistant_message_embedding e
                where e.user_id = ${input.userId}
                  and to_tsvector('simple', coalesce(e.excerpt_md, ''))
                      @@ plainto_tsquery('simple', ${query})
                order by score desc
                limit ${input.limit}
            `)
        return mapHits(rows, "keyword")
    } catch (error) {
        console.error("[assistant] operator FTS skipped", error)
        return searchOperatorHistoryIlikeFallback(input)
    }
}

async function searchOperatorHistoryIlikeFallback(input: {
    userId: number
    query: string
    limit: number
    excludeThreadId?: number | null
}): Promise<OperatorHistoryHit[]> {
    const pattern = `%${input.query.trim().slice(0, 80)}%`
    try {
        const exclude = input.excludeThreadId
        const rows = exclude
            ? await getDb().execute(sql`
                select e.thread_id, e.message_id, e.excerpt_md, 0.5::float8 as score
                from petrichor_assistant_message_embedding e
                where e.user_id = ${input.userId}
                  and e.thread_id <> ${exclude}
                  and e.excerpt_md ilike ${pattern}
                order by e.message_id desc
                limit ${input.limit}
            `)
            : await getDb().execute(sql`
                select e.thread_id, e.message_id, e.excerpt_md, 0.5::float8 as score
                from petrichor_assistant_message_embedding e
                where e.user_id = ${input.userId}
                  and e.excerpt_md ilike ${pattern}
                order by e.message_id desc
                limit ${input.limit}
            `)
        return mapHits(rows, "keyword")
    } catch {
        return []
    }
}

export async function searchOperatorHistorySemantic(input: {
    userId: number
    query: string
    limit: number
    excludeThreadId?: number | null
}): Promise<OperatorHistoryHit[]> {
    const query = input.query.trim()
    if (!query) return []
    if (isSqliteDatabase()) return []
    try {
        if (!(await hasEmbeddingConfig(input.userId))) return []
        const vector = await embedQuery(input.userId, query.slice(0, 4_000))
        if (!vector?.length) return []
        const literal = `[${vector.join(",")}]`
        // 该表没有维度元数据列，按当前向量的实际长度过滤，避免跨维度比较报错
        const dims = vector.length
        const exclude = input.excludeThreadId
        const rows = exclude
            ? await getDb().execute(sql`
                select e.thread_id, e.message_id, e.excerpt_md,
                    (${cosineSimilarity("e.embedding", literal, dims)})::float8 as score
                from petrichor_assistant_message_embedding e
                where e.user_id = ${input.userId}
                  and e.thread_id <> ${exclude}
                  and e.embedding is not null
                  and ${whereSameDimension("e.embedding", dims)}
                order by ${cosineDistance("e.embedding", literal, dims)}
                limit ${input.limit}
            `)
            : await getDb().execute(sql`
                select e.thread_id, e.message_id, e.excerpt_md,
                    (${cosineSimilarity("e.embedding", literal, dims)})::float8 as score
                from petrichor_assistant_message_embedding e
                where e.user_id = ${input.userId}
                  and e.embedding is not null
                  and ${whereSameDimension("e.embedding", dims)}
                order by ${cosineDistance("e.embedding", literal, dims)}
                limit ${input.limit}
            `)
        return mapHits(rows, "semantic").filter((hit) => hit.score >= CONTEXT_RECALL_MIN_SCORE)
    } catch (error) {
        console.error("[assistant] operator semantic recall skipped", error)
        return []
    }
}

function mapHits(rows: unknown, source: "keyword" | "semantic"): OperatorHistoryHit[] {
    const hits: OperatorHistoryHit[] = []
    for (const row of rows as Array<Record<string, unknown>>) {
        const threadId = Number(row.thread_id)
        const messageId = Number(row.message_id)
        const score = Number(row.score)
        const excerpt = typeof row.excerpt_md === "string"
            ? sanitizeRecallExcerpt(row.excerpt_md)
            : ""
        if (!Number.isFinite(threadId) || !Number.isFinite(messageId) || !excerpt) continue
        hits.push({
            threadId: String(threadId),
            messageId: String(messageId),
            excerpt,
            score: Number.isFinite(score) ? score : 0,
            source,
        })
    }
    return hits
}

export async function searchOperatorHistory(input: {
    userId: number
    query: string
    mode: "keyword" | "semantic" | "both"
    limit: number
    excludeThreadId?: number | null
}): Promise<OperatorHistoryHit[]> {
    const limit = Math.min(20, Math.max(1, input.limit))
    if (input.mode === "keyword") {
        return searchOperatorHistoryFts({ ...input, limit })
    }
    if (input.mode === "semantic") {
        return searchOperatorHistorySemantic({ ...input, limit })
    }
    const [keywordHits, semanticHits] = await Promise.all([
        searchOperatorHistoryFts({ ...input, limit }),
        searchOperatorHistorySemantic({ ...input, limit }),
    ])
    const seen = new Set<string>()
    const merged: OperatorHistoryHit[] = []
    for (const hit of [...semanticHits, ...keywordHits]) {
        const key = `${hit.threadId}:${hit.messageId}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(hit)
        if (merged.length >= limit) break
    }
    return merged
}
