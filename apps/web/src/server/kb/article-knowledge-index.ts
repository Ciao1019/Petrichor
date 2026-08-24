import { createHash } from "node:crypto"
import { and, asc, eq, isNull, like, notInArray, or, sql } from "drizzle-orm"

import {
    embedQuery,
    embedTexts,
    getEmbeddingProfile,
    hasEmbeddingConfig,
    type EmbeddingProfile,
} from "@/server/ai/embedding"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import {
    knowledgeBaseArticleChunkIndexes,
    knowledgeBaseArticleChunks,
    knowledgeBaseArticles,
    knowledgeBases,
    knowledgeBaseWikiPages,
    type KnowledgeBaseArticleChunkRecord,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { scoreSearchFields } from "@/server/kb/search-terms"
import { readFrontmatterAliases } from "@/server/kb/wiki-qa-core"
import { bm25Search } from "@/server/retrieval/bm25"
import { buildIndexTokenText, buildQueryTokens, buildTsQuery } from "@/server/retrieval/tokenize"
import { cosineDistance, cosineSimilarity, whereSameDimension } from "@/server/retrieval/vector-space"

export type ArticleKnowledgeIndexSource = "chunk" | "question"

export type ArticleKnowledgeIndexValue = {
    userId: number
    knowledgeBaseId: number
    articleId: number
    chunkId: number
    sourceKey: string
    sourceType: ArticleKnowledgeIndexSource
    sourcePosition: number
    content: string
    embeddingText: string
    contentHash: string
    searchTokens: string
    embeddingStatus: "pending"
    embeddingVersion: number
    updatedAt: Date
}

export type ArticleKnowledgeSearchHit = {
    candidateKey: string
    chunkId: string
    articleId: string
    knowledgeBaseId: string
    articleTitle: string
    chunkKey: string
    title: string
    path: string[]
    summary: string
    contentMd: string
    matchedSource: ArticleKnowledgeIndexSource
    matchedContent: string
    score?: number
}

export type WikiKnowledgeSearchHit = {
    candidateKey: string
    pageKey: string
    articleId: string
    knowledgeBaseId: string
    title: string
    kind: string
    aliases: string[]
    summary: string
    contentMd: string
    score: number
}

export type ArticleKnowledgeSearchGroups = {
    chunk: ArticleKnowledgeSearchHit[]
    question: ArticleKnowledgeSearchHit[]
}

export type ArticleKnowledgeIndexPhaseStatus = {
    total: number
    embedded: number
    pending: number
    failed: number
}

export type ArticleKnowledgeIndexStatus = {
    supported: boolean
    total: number
    embedded: number
    pending: number
    failed: number
    chunk: ArticleKnowledgeIndexPhaseStatus
    question: ArticleKnowledgeIndexPhaseStatus
    model: string | null
    dimensions: number | null
    version: number | null
}

/**
 * 分片索引文本版本。它只描述“标题/标题路径/正文（或问题）如何拼成 embeddingText”，
 * 与切分算法版本解耦；拼接策略变更时递增，历史向量会自动进入待重算状态。
 */
export const ARTICLE_KNOWLEDGE_INDEX_VERSION = 1

const INDEX_BATCH_SIZE = 64
const MAX_EMBED_PER_PHASE = 2_000
const MAX_EMBED_TEXT_CHARS = 4_000
const LEXICAL_POOL_LIMIT = 400

function hashText(value: string) {
    return createHash("sha256").update(value).digest("hex")
}

function parseStringArray(raw: string | null | undefined): string[] {
    if (!raw?.trim()) return []
    try {
        const value = JSON.parse(raw) as unknown
        return Array.isArray(value)
            ? value.map((item) => String(item).trim()).filter(Boolean)
            : []
    } catch {
        return []
    }
}

function normalizedHeadingPath(chunk: Pick<KnowledgeBaseArticleChunkRecord, "heading" | "headingPathJson">) {
    const path = parseStringArray(chunk.headingPathJson)
    return path.length > 0 ? path : [chunk.heading]
}

function buildEmbeddingText(articleTitle: string, headingPath: string[], content: string) {
    const prefix = [articleTitle, headingPath.join(" > ")]
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item, index, values) => values.indexOf(item) === index)
    return [...prefix, content.trim()].filter(Boolean).join("\n").slice(0, MAX_EMBED_TEXT_CHARS)
}

/**
 * 把持久化分片展开成检索条目。数组顺序就是写入/向量化顺序：全部 chunk 在前，
 * 全部 question 在后；每个 question 仍通过 chunkId 指回对应原文分片。
 */
export function buildArticleKnowledgeIndexValues(input: {
    userId: number
    knowledgeBaseId: number
    articleId: number
    articleTitle: string
    chunks: Array<Pick<KnowledgeBaseArticleChunkRecord,
        "id" | "chunkKey" | "heading" | "headingPathJson" | "contentMd" | "recommendedQuestionsJson">>
    now?: Date
}): ArticleKnowledgeIndexValue[] {
    const now = input.now ?? new Date()
    const chunks = [...input.chunks].sort((left, right) => left.id - right.id)
    const chunkValues = chunks.map((chunk) => {
        const headingPath = normalizedHeadingPath(chunk)
        const embeddingText = buildEmbeddingText(input.articleTitle, headingPath, chunk.contentMd)
        return {
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: input.articleId,
            chunkId: chunk.id,
            sourceKey: `${chunk.chunkKey}:chunk`,
            sourceType: "chunk" as const,
            sourcePosition: 0,
            content: chunk.contentMd,
            embeddingText,
            contentHash: hashText(embeddingText),
            searchTokens: buildIndexTokenText(embeddingText),
            embeddingStatus: "pending" as const,
            embeddingVersion: ARTICLE_KNOWLEDGE_INDEX_VERSION,
            updatedAt: now,
        }
    })
    const questionValues = chunks.flatMap((chunk) => {
        const headingPath = normalizedHeadingPath(chunk)
        return parseStringArray(chunk.recommendedQuestionsJson).map((question, index) => {
            const embeddingText = buildEmbeddingText(input.articleTitle, headingPath, question)
            return {
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                articleId: input.articleId,
                chunkId: chunk.id,
                sourceKey: `${chunk.chunkKey}:question:${index}`,
                sourceType: "question" as const,
                sourcePosition: index,
                content: question,
                embeddingText,
                contentHash: hashText(embeddingText),
                searchTokens: buildIndexTokenText(embeddingText),
                embeddingStatus: "pending" as const,
                embeddingVersion: ARTICLE_KNOWLEDGE_INDEX_VERSION,
                updatedAt: now,
            }
        })
    })
    return [...chunkValues, ...questionValues]
}

async function assertOwnedKnowledgeBase(userId: number, knowledgeBaseId: number) {
    const [row] = await getDb()
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, userId)))
        .limit(1)
    if (!row) throw notFound("知识库不存在")
}

async function loadEmbeddingProfileOrNull(userId: number): Promise<EmbeddingProfile | null> {
    try {
        if (!(await hasEmbeddingConfig(userId))) return null
        return await getEmbeddingProfile(userId)
    } catch {
        return null
    }
}

type PendingIndexRow = { id: number; embeddingText: string }

async function loadPendingRows(
    userId: number,
    knowledgeBaseId: number,
    sourceType: ArticleKnowledgeIndexSource,
    profile: EmbeddingProfile,
): Promise<{ rows: PendingIndexRow[]; hasMore: boolean }> {
    const rows = await getDb()
        .select({
            id: knowledgeBaseArticleChunkIndexes.id,
            embeddingText: knowledgeBaseArticleChunkIndexes.embeddingText,
        })
        .from(knowledgeBaseArticleChunkIndexes)
        .where(and(
            eq(knowledgeBaseArticleChunkIndexes.userId, userId),
            eq(knowledgeBaseArticleChunkIndexes.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseArticleChunkIndexes.sourceType, sourceType),
            sql`${knowledgeBaseArticleChunkIndexes.id} in (
                select id from petrichor_kb_article_chunk_index
                where user_id = ${userId}
                  and knowledge_base_id = ${knowledgeBaseId}
                  and source_type = ${sourceType}
                  and (embedding is null or embedding_status <> 'ready'
                    or embedding_model is distinct from ${profile.model}
                    or embedding_dimensions is distinct from ${profile.dimensions}
                    or embedding_version is distinct from ${profile.version})
            )`,
        ))
        .orderBy(asc(knowledgeBaseArticleChunkIndexes.articleId), asc(knowledgeBaseArticleChunkIndexes.chunkId), asc(knowledgeBaseArticleChunkIndexes.sourcePosition))
        .limit(MAX_EMBED_PER_PHASE + 1)
    return { rows: rows.slice(0, MAX_EMBED_PER_PHASE), hasMore: rows.length > MAX_EMBED_PER_PHASE }
}

async function writeIndexEmbeddings(
    userId: number,
    rows: PendingIndexRow[],
    profile: EmbeddingProfile,
) {
    let written = 0
    for (let offset = 0; offset < rows.length; offset += INDEX_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + INDEX_BATCH_SIZE)
        let vectors: number[][]
        try {
            vectors = await embedTexts(userId, batch.map((row) => row.embeddingText))
        } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 1000) : "向量生成失败"
            for (const row of batch) {
                await getDb().update(knowledgeBaseArticleChunkIndexes).set({
                    embeddingStatus: "failed",
                    embeddingError: message,
                    embeddingUpdatedAt: new Date(),
                }).where(eq(knowledgeBaseArticleChunkIndexes.id, row.id))
            }
            throw error
        }
        for (let index = 0; index < batch.length; index += 1) {
            const vector = vectors[index]
            const row = batch[index]
            if (!vector || !row) continue
            const literal = `[${vector.join(",")}]`
            await getDb().execute(sql`
                update petrichor_kb_article_chunk_index
                set embedding = ${literal}::vector,
                    embedding_status = 'ready',
                    embedding_model = ${profile.model},
                    embedding_dimensions = ${vector.length},
                    embedding_version = ${profile.version},
                    embedding_error = null,
                    embedding_updated_at = now(),
                    updated_at = now()
                where id = ${row.id}
            `)
            written += 1
        }
    }
    return written
}

async function readStatusRows(userId: number, knowledgeBaseId: number, profile: EmbeddingProfile | null) {
    if (isSqliteDatabase()) {
        return await getDb()
            .select({
                sourceType: knowledgeBaseArticleChunkIndexes.sourceType,
                embeddingStatus: knowledgeBaseArticleChunkIndexes.embeddingStatus,
                embeddingModel: knowledgeBaseArticleChunkIndexes.embeddingModel,
                embeddingDimensions: knowledgeBaseArticleChunkIndexes.embeddingDimensions,
                embeddingVersion: knowledgeBaseArticleChunkIndexes.embeddingVersion,
            })
            .from(knowledgeBaseArticleChunkIndexes)
            .where(and(
                eq(knowledgeBaseArticleChunkIndexes.userId, userId),
                eq(knowledgeBaseArticleChunkIndexes.knowledgeBaseId, knowledgeBaseId),
            ))
    }

    const countable = profile?.dimensions != null ? profile : null
    const result = await getDb().execute(sql`
        select source_type,
          count(*)::int as total,
          count(*) filter (where ${countable ? sql`embedding is not null
              and embedding_status = 'ready'
              and embedding_model = ${countable.model}
              and embedding_dimensions = ${countable.dimensions}
              and embedding_version = ${countable.version}` : sql`false`})::int as embedded,
          count(*) filter (where embedding_status = 'failed')::int as failed
        from petrichor_kb_article_chunk_index
        where user_id = ${userId} and knowledge_base_id = ${knowledgeBaseId}
        group by source_type
    `)
    return resultRows(result)
}

function emptyPhase(): ArticleKnowledgeIndexPhaseStatus {
    return { total: 0, embedded: 0, pending: 0, failed: 0 }
}

export async function getKnowledgeBaseArticleIndexStatus(
    userId: number,
    knowledgeBaseId: number,
): Promise<ArticleKnowledgeIndexStatus> {
    await assertOwnedKnowledgeBase(userId, knowledgeBaseId)
    const profile = await loadEmbeddingProfileOrNull(userId)
    const rows = await readStatusRows(userId, knowledgeBaseId, profile)
    const phases = { chunk: emptyPhase(), question: emptyPhase() }

    if (isSqliteDatabase()) {
        for (const raw of rows as Array<Record<string, unknown>>) {
            const source = String(raw.sourceType ?? "") as ArticleKnowledgeIndexSource
            if (source !== "chunk" && source !== "question") continue
            const phase = phases[source]
            phase.total += 1
            const ready = profile?.dimensions != null
                && raw.embeddingStatus === "ready"
                && raw.embeddingModel === profile.model
                && Number(raw.embeddingDimensions) === profile.dimensions
                && Number(raw.embeddingVersion) === profile.version
            if (ready) phase.embedded += 1
            if (raw.embeddingStatus === "failed") phase.failed += 1
        }
    } else {
        for (const raw of rows as Array<Record<string, unknown>>) {
            const source = String(raw.source_type ?? "") as ArticleKnowledgeIndexSource
            if (source !== "chunk" && source !== "question") continue
            phases[source].total = Number(raw.total ?? 0)
            phases[source].embedded = Number(raw.embedded ?? 0)
            phases[source].failed = Number(raw.failed ?? 0)
        }
    }
    for (const phase of Object.values(phases)) {
        phase.pending = Math.max(phase.total - phase.embedded, 0)
    }
    const total = phases.chunk.total + phases.question.total
    const embedded = phases.chunk.embedded + phases.question.embedded
    return {
        supported: !isSqliteDatabase(),
        total,
        embedded,
        pending: Math.max(total - embedded, 0),
        failed: phases.chunk.failed + phases.question.failed,
        chunk: phases.chunk,
        question: phases.question,
        model: profile?.model ?? null,
        dimensions: profile?.dimensions ?? null,
        version: profile?.version ?? null,
    }
}

/**
 * 严格的两阶段向量化：只有全部分片向量已经就绪，才开始推荐问题向量。
 * 超大知识库一次处理不完时，下一次调用会继续分片阶段，不会提前混入问题阶段。
 */
export async function embedKnowledgeBaseArticleIndex(userId: number, knowledgeBaseId: number) {
    if (isSqliteDatabase()) throw badRequest("向量生成需要 PostgreSQL 数据库")
    await assertOwnedKnowledgeBase(userId, knowledgeBaseId)
    if (!(await hasEmbeddingConfig(userId))) {
        throw badRequest("未配置向量模型：请先在「AI 模型配置」绑定 EMBEDDING 模型")
    }
    const profile = await getEmbeddingProfile(userId)
    const chunkPhase = await loadPendingRows(userId, knowledgeBaseId, "chunk", profile)
    const embeddedChunks = await writeIndexEmbeddings(userId, chunkPhase.rows, profile)

    let embeddedQuestions = 0
    // 必须等分片阶段彻底清空，问题才有资格进入向量模型。
    if (!chunkPhase.hasMore) {
        const remainingChunks = await loadPendingRows(userId, knowledgeBaseId, "chunk", await getEmbeddingProfile(userId))
        if (remainingChunks.rows.length === 0) {
            const questionPhase = await loadPendingRows(userId, knowledgeBaseId, "question", await getEmbeddingProfile(userId))
            embeddedQuestions = await writeIndexEmbeddings(userId, questionPhase.rows, await getEmbeddingProfile(userId))
        }
    }

    const status = await getKnowledgeBaseArticleIndexStatus(userId, knowledgeBaseId)
    const { embedded: ready, ...statusWithoutReady } = status
    return {
        embedded: embeddedChunks + embeddedQuestions,
        embeddedChunks,
        embeddedQuestions,
        ready,
        ...statusWithoutReady,
    }
}

/** 构建知识后的 best-effort 自动索引；无模型配置时不制造告警。 */
export async function embedKnowledgeBaseArticleIndexBestEffort(userId: number, knowledgeBaseId: number) {
    if (isSqliteDatabase() || !(await hasEmbeddingConfig(userId))) return null
    return await embedKnowledgeBaseArticleIndex(userId, knowledgeBaseId)
}

type IndexCandidateRow = {
    indexId: string
    chunkId: string
    articleId: string
    knowledgeBaseId: string
    sourceType: ArticleKnowledgeIndexSource
    sourcePosition: number
    matchedContent: string
    embeddingText: string
    articleTitle: string
    chunkKey: string
    heading: string
    headingPathJson: string
    contentMd: string
    score?: number
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>
    const rows = (result as { rows?: unknown })?.rows
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>
    if (result && typeof result === "object" && Symbol.iterator in result) {
        return [...result as Iterable<Record<string, unknown>>]
    }
    return []
}

function mapSqlIndexRow(row: Record<string, unknown>): IndexCandidateRow {
    return {
        indexId: String(row.index_id ?? ""),
        chunkId: String(row.chunk_id ?? ""),
        articleId: String(row.article_id ?? ""),
        knowledgeBaseId: String(row.knowledge_base_id ?? ""),
        sourceType: String(row.source_type ?? "chunk") as ArticleKnowledgeIndexSource,
        sourcePosition: Number(row.source_position ?? 0),
        matchedContent: String(row.matched_content ?? ""),
        embeddingText: String(row.embedding_text ?? ""),
        articleTitle: String(row.article_title ?? ""),
        chunkKey: String(row.chunk_key ?? ""),
        heading: String(row.heading ?? ""),
        headingPathJson: String(row.heading_path_json ?? "[]"),
        contentMd: String(row.content_md ?? ""),
        ...(row.score == null ? {} : { score: Number(row.score) }),
    }
}

function mapDrizzleIndexRow(row: {
    indexId: number
    chunkId: number
    articleId: number
    knowledgeBaseId: number
    sourceType: string
    sourcePosition: number
    matchedContent: string
    embeddingText: string
    articleTitle: string
    chunkKey: string
    heading: string
    headingPathJson: string
    contentMd: string
}): IndexCandidateRow {
    return {
        ...row,
        indexId: String(row.indexId),
        chunkId: String(row.chunkId),
        articleId: String(row.articleId),
        knowledgeBaseId: String(row.knowledgeBaseId),
        sourceType: row.sourceType as ArticleKnowledgeIndexSource,
    }
}

function toSearchHit(row: IndexCandidateRow, score?: number): ArticleKnowledgeSearchHit {
    const path = parseStringArray(row.headingPathJson)
    const normalizedPath = path.length > 0 ? path : [row.heading]
    return {
        candidateKey: `chunk:${row.knowledgeBaseId}:${row.chunkId}`,
        chunkId: row.chunkId,
        articleId: row.articleId,
        knowledgeBaseId: row.knowledgeBaseId,
        articleTitle: row.articleTitle,
        chunkKey: row.chunkKey,
        title: row.heading || row.articleTitle,
        path: [row.articleTitle, ...normalizedPath].filter(Boolean),
        summary: row.sourceType === "question"
            ? `用户问法：${row.matchedContent}`
            : row.contentMd.replace(/\s+/g, " ").trim().slice(0, 220),
        contentMd: row.contentMd,
        matchedSource: row.sourceType,
        matchedContent: row.matchedContent,
        ...((score ?? row.score) == null ? {} : { score: score ?? row.score }),
    }
}

function dedupeByChunk(rows: IndexCandidateRow[], limit: number) {
    const seen = new Set<string>()
    const hits: ArticleKnowledgeSearchHit[] = []
    for (const row of rows) {
        const key = `${row.knowledgeBaseId}:${row.chunkId}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push(toSearchHit(row))
        if (hits.length >= limit) break
    }
    return hits
}

async function vectorRows(input: {
    userId: number
    knowledgeBaseId?: number
    articleId?: number
    sourceType: ArticleKnowledgeIndexSource
    literal: string
    dimensions: number
    profile: EmbeddingProfile
    limit: number
}): Promise<IndexCandidateRow[]> {
    const fetchLimit = input.sourceType === "question" ? input.limit * 3 : input.limit
    const result = await getDb().execute(sql`
        select i.id as index_id, i.chunk_id, i.article_id, i.knowledge_base_id,
          i.source_type, i.source_position, i.content as matched_content, i.embedding_text,
          a.title as article_title, c.chunk_key, c.heading, c.heading_path_json, c.content_md,
          ${cosineSimilarity("i.embedding", input.literal, input.dimensions)} as score
        from petrichor_kb_article_chunk_index i
        join petrichor_kb_article_chunk c on c.id = i.chunk_id
        join petrichor_kb_article a on a.id = i.article_id
        where i.user_id = ${input.userId}
          ${input.knowledgeBaseId != null ? sql`and i.knowledge_base_id = ${input.knowledgeBaseId}` : sql``}
          ${input.articleId != null ? sql`and i.article_id = ${input.articleId}` : sql``}
          and i.source_type = ${input.sourceType}
          and i.embedding is not null
          and ${whereSameDimension("i.embedding", input.dimensions)}
          and i.embedding_status = 'ready'
          and i.embedding_model = ${input.profile.model}
          and i.embedding_dimensions = ${input.dimensions}
          and i.embedding_version = ${input.profile.version}
        order by ${cosineDistance("i.embedding", input.literal, input.dimensions)}
        limit ${fetchLimit}
    `)
    return resultRows(result).map(mapSqlIndexRow)
}

/** 一次 query embedding，同时检索分片向量和问题向量；两路结果稍后按 chunkId 融合。 */
export async function semanticSearchArticleKnowledge(input: {
    userId: number
    knowledgeBaseId?: number
    articleId?: number
    query: string
    limit: number
}): Promise<ArticleKnowledgeSearchGroups> {
    if (isSqliteDatabase()) throw badRequest("向量语义检索需要 PostgreSQL 数据库")
    if (input.knowledgeBaseId != null) await assertOwnedKnowledgeBase(input.userId, input.knowledgeBaseId)
    const query = input.query.trim()
    if (!query) return { chunk: [], question: [] }
    const vector = await embedQuery(input.userId, query)
    const profile = await getEmbeddingProfile(input.userId)
    const literal = `[${vector.join(",")}]`
    const common = {
        userId: input.userId,
        ...(input.knowledgeBaseId != null ? { knowledgeBaseId: input.knowledgeBaseId } : {}),
        ...(input.articleId != null ? { articleId: input.articleId } : {}),
        literal,
        dimensions: vector.length,
        profile,
        limit: input.limit,
    }
    const [chunkRows, questionRows] = await Promise.all([
        vectorRows({ ...common, sourceType: "chunk" }),
        vectorRows({ ...common, sourceType: "question" }),
    ])
    return {
        chunk: dedupeByChunk(chunkRows, input.limit),
        question: dedupeByChunk(questionRows, input.limit),
    }
}

async function loadLexicalPool(input: {
    userId: number
    knowledgeBaseId?: number
    articleId?: number
    sourceType: ArticleKnowledgeIndexSource
    tokens: string[]
}): Promise<IndexCandidateRow[]> {
    if (!isSqliteDatabase()) {
        const tsquery = buildTsQuery(input.tokens)
        if (tsquery) {
            try {
                const result = await getDb().execute(sql`
                    select i.id as index_id, i.chunk_id, i.article_id, i.knowledge_base_id,
                      i.source_type, i.source_position, i.content as matched_content, i.embedding_text,
                      a.title as article_title, c.chunk_key, c.heading, c.heading_path_json, c.content_md
                    from petrichor_kb_article_chunk_index i
                    join petrichor_kb_article_chunk c on c.id = i.chunk_id
                    join petrichor_kb_article a on a.id = i.article_id
                    where i.user_id = ${input.userId}
                      ${input.knowledgeBaseId != null ? sql`and i.knowledge_base_id = ${input.knowledgeBaseId}` : sql``}
                      ${input.articleId != null ? sql`and i.article_id = ${input.articleId}` : sql``}
                      and i.source_type = ${input.sourceType}
                      and i.search_vector @@ to_tsquery('simple', ${tsquery})
                    order by ts_rank_cd(i.search_vector, to_tsquery('simple', ${tsquery})) desc
                    limit ${LEXICAL_POOL_LIMIT}
                `)
                const rows = resultRows(result).map(mapSqlIndexRow)
                if (rows.length > 0) return rows
            } catch {
                // 迁移未执行或 search_vector 尚未生成：退回原文 LIKE 候选池。
            }
        }
    }

    const conditions = input.tokens.slice(0, 16).map((token) =>
        like(knowledgeBaseArticleChunkIndexes.embeddingText, `%${escapeLike(token)}%`))
    const lexical = or(...conditions)
    const rows = await getDb()
        .select({
            indexId: knowledgeBaseArticleChunkIndexes.id,
            chunkId: knowledgeBaseArticleChunkIndexes.chunkId,
            articleId: knowledgeBaseArticleChunkIndexes.articleId,
            knowledgeBaseId: knowledgeBaseArticleChunkIndexes.knowledgeBaseId,
            sourceType: knowledgeBaseArticleChunkIndexes.sourceType,
            sourcePosition: knowledgeBaseArticleChunkIndexes.sourcePosition,
            matchedContent: knowledgeBaseArticleChunkIndexes.content,
            embeddingText: knowledgeBaseArticleChunkIndexes.embeddingText,
            articleTitle: knowledgeBaseArticles.title,
            chunkKey: knowledgeBaseArticleChunks.chunkKey,
            heading: knowledgeBaseArticleChunks.heading,
            headingPathJson: knowledgeBaseArticleChunks.headingPathJson,
            contentMd: knowledgeBaseArticleChunks.contentMd,
        })
        .from(knowledgeBaseArticleChunkIndexes)
        .innerJoin(knowledgeBaseArticleChunks, eq(knowledgeBaseArticleChunks.id, knowledgeBaseArticleChunkIndexes.chunkId))
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleChunkIndexes.articleId))
        .where(and(
            eq(knowledgeBaseArticleChunkIndexes.userId, input.userId),
            eq(knowledgeBaseArticleChunkIndexes.sourceType, input.sourceType),
            ...(input.knowledgeBaseId != null
                ? [eq(knowledgeBaseArticleChunkIndexes.knowledgeBaseId, input.knowledgeBaseId)]
                : []),
            ...(input.articleId != null ? [eq(knowledgeBaseArticleChunkIndexes.articleId, input.articleId)] : []),
            ...(lexical ? [lexical] : []),
        ))
        .limit(LEXICAL_POOL_LIMIT)
    return rows.map(mapDrizzleIndexRow)
}

function escapeLike(value: string) {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function rankLexicalRows(rows: IndexCandidateRow[], query: string, limit: number) {
    const hits = bm25Search(rows.map((row) => ({
        id: row.indexId,
        title: `${row.articleTitle} ${row.heading}`,
        content: row.embeddingText,
    })), query, { topK: Math.min(rows.length, limit * 3), corpusSize: rows.length })
    const byId = new Map(rows.map((row) => [row.indexId, row]))
    const ranked = hits.flatMap((hit) => {
        const row = byId.get(hit.id)
        return row ? [{ ...row, score: hit.score }] : []
    })
    return dedupeByChunk(ranked, limit)
}

export async function lexicalSearchArticleKnowledge(input: {
    userId: number
    knowledgeBaseId?: number
    articleId?: number
    query: string
    limit: number
}): Promise<ArticleKnowledgeSearchGroups> {
    if (input.knowledgeBaseId != null) await assertOwnedKnowledgeBase(input.userId, input.knowledgeBaseId)
    const tokens = buildQueryTokens(input.query)
    if (tokens.length === 0) return { chunk: [], question: [] }
    const common = {
        userId: input.userId,
        ...(input.knowledgeBaseId != null ? { knowledgeBaseId: input.knowledgeBaseId } : {}),
        ...(input.articleId != null ? { articleId: input.articleId } : {}),
        tokens,
    }
    const [chunkRows, questionRows] = await Promise.all([
        loadLexicalPool({ ...common, sourceType: "chunk" }),
        loadLexicalPool({ ...common, sourceType: "question" }),
    ])
    return {
        chunk: rankLexicalRows(chunkRows, input.query, input.limit),
        question: rankLexicalRows(questionRows, input.query, input.limit),
    }
}

/**
 * 新 Wiki 是 LLM 汇总的实体/概念页面，不再把 PageIndex 章节树当作 Wiki 本体。
 * 搜索标题、pageKey、摘要和正文，结果用于概念导航；精确事实仍由 chunk 深读核验。
 */
export async function searchKnowledgeWikiPages(input: {
    userId: number
    knowledgeBaseId?: number
    query: string
    limit: number
}): Promise<WikiKnowledgeSearchHit[]> {
    if (input.knowledgeBaseId != null) await assertOwnedKnowledgeBase(input.userId, input.knowledgeBaseId)
    const tokens = buildQueryTokens(input.query)
    if (tokens.length === 0) return []
    const conditions = tokens.slice(0, 16).flatMap((token) => {
        const pattern = `%${escapeLike(token)}%`
        return [
            like(knowledgeBaseWikiPages.title, pattern),
            like(knowledgeBaseWikiPages.pageKey, pattern),
            like(knowledgeBaseWikiPages.summary, pattern),
            like(knowledgeBaseWikiPages.contentMd, pattern),
        ]
    })
    const lexical = or(...conditions)
    const pages = await getDb()
        .select()
        .from(knowledgeBaseWikiPages)
        .where(and(
            eq(knowledgeBaseWikiPages.userId, input.userId),
            isNull(knowledgeBaseWikiPages.archivedAt),
            // source/index 是导航或编译清单，不是新版 Wiki 的实体/概念知识面；
            // 让它们抢先命中会遮住更精确的分片，且会阻断存量 Tree 兜底。
            notInArray(knowledgeBaseWikiPages.kind, ["source", "index", "log"]),
            ...(input.knowledgeBaseId != null ? [eq(knowledgeBaseWikiPages.knowledgeBaseId, input.knowledgeBaseId)] : []),
            ...(lexical ? [lexical] : []),
        ))
        .limit(LEXICAL_POOL_LIMIT)

    return pages
        .map((page) => ({
            page,
            score: scoreSearchFields({
                title: page.title,
                summary: page.summary,
                content: page.contentMd,
                extra: page.pageKey,
            }, input.query),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || right.page.updatedAt.getTime() - left.page.updatedAt.getTime())
        .slice(0, input.limit)
        .map(({ page, score }) => ({
            candidateKey: `wiki:${page.knowledgeBaseId}:${page.pageKey}`,
            pageKey: page.pageKey,
            articleId: page.pageKey.match(/^source-(\d+)$/)?.[1] ?? "",
            knowledgeBaseId: String(page.knowledgeBaseId),
            title: page.title,
            kind: page.kind,
            aliases: readFrontmatterAliases(page.frontmatterJson),
            summary: page.summary?.trim() || page.contentMd.replace(/\s+/g, " ").trim().slice(0, 220),
            contentMd: page.contentMd,
            score,
        }))
}

/** 读取检索命中的原始分片；问题索引不会成为证据正文。 */
export async function readArticleKnowledgeChunkForAgent(
    userId: number,
    knowledgeBaseId: number,
    chunkId: number,
) {
    const [row] = await getDb()
        .select({ chunk: knowledgeBaseArticleChunks, article: knowledgeBaseArticles })
        .from(knowledgeBaseArticleChunks)
        .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticles.id, knowledgeBaseArticleChunks.articleId))
        .where(and(
            eq(knowledgeBaseArticleChunks.id, chunkId),
            eq(knowledgeBaseArticleChunks.userId, userId),
            eq(knowledgeBaseArticleChunks.knowledgeBaseId, knowledgeBaseId),
            eq(knowledgeBaseArticles.userId, userId),
        ))
        .limit(1)
    if (!row) throw notFound("文章分片不存在")
    const headingPath = normalizedHeadingPath(row.chunk)
    return {
        kind: "article_chunk" as const,
        knowledgeBaseId: String(knowledgeBaseId),
        chunkId: String(row.chunk.id),
        chunkKey: row.chunk.chunkKey,
        articleId: String(row.article.id),
        articleTitle: row.article.title,
        title: row.chunk.heading || row.article.title,
        breadcrumb: [row.article.title, ...headingPath].filter(Boolean),
        contextMd: `文章：${row.article.title}\n章节：${headingPath.join(" > ")}`,
        contentMd: row.chunk.contentMd,
        recommendedQuestions: parseStringArray(row.chunk.recommendedQuestionsJson),
    }
}
