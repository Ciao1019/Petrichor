import { and, eq, like, or, sql } from "drizzle-orm"
import { resolveBm25FieldWeights, resolveRecallConfig, readAgentFeatureFlags, type RecallConfig } from "@/server/assistant/agent-runtime/config"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { knowledgeBaseWikiTreeNodes } from "@/server/db/schema"
import { bm25Search } from "@/server/retrieval/bm25"
import { reciprocalRankFusion, toRecallHits, type FusedCandidate, type RecallSource } from "@/server/retrieval/fusion"
import { createReranker, rerankAdaptively, type Reranker } from "@/server/retrieval/reranker"
import { buildQueryTokens, buildTsQuery } from "@/server/retrieval/tokenize"
import { assertKnowledgeBaseOwner } from "./wiki-agent-logic"
import {
    lexicalSearchArticleKnowledge,
    searchKnowledgeWikiPages,
    semanticSearchArticleKnowledge,
    type ArticleKnowledgeSearchGroups,
    type ArticleKnowledgeSearchHit,
    type WikiKnowledgeSearchHit,
} from "./article-knowledge-index"
import {
    retrieveTreeNodesForAgent,
    semanticSearchTreeNodes,
    semanticSearchTreeNodesAcrossKbs,
    type TreeRetrievalHit,
} from "./wiki-tree"

/**
 * 知识召回管线（§24/§28/§29/§158）：
 *
 *   Tree Recall + Vector Recall + BM25 Recall → RRF → Rerank → Candidate Nodes
 *
 * 三路召回各自独立失败：任意一路挂掉都只是少一路排名，不影响整体（§141）。
 * 本函数只产出候选，正文深读由 Agent 显式调用 knowledge.read（§31）。
 */

export type KnowledgeCandidate = {
    nodeKey: string
    /** RRF / 去重使用的全局候选键；新索引不再把 chunk/page 冒充旧 Tree nodeKey。 */
    candidateKey?: string
    candidateKind?: "chunk" | "wiki" | "tree"
    /** candidateKind=wiki 时的页面类型与别名，供回答正文做实体/概念标注。 */
    pageKind?: string
    aliases?: string[]
    chunkId?: string
    pageKey?: string
    articleId: string
    knowledgeBaseId: string
    title: string
    path?: string[]
    summary?: string
    score?: number
    rerankScore?: number
    recallSources: RecallSource[]
    reason?: string
}

export type RecallDiagnostics = {
    query: string
    rewrittenQueries: string[]
    treeKeys: string[]
    vectorKeys: string[]
    bm25Keys: string[]
    chunkVectorKeys: string[]
    questionVectorKeys: string[]
    chunkBm25Keys: string[]
    questionBm25Keys: string[]
    wikiKeys: string[]
    fusionKeys: string[]
    finalKeys: string[]
    /** 两阶段召回第一阶段选中的文章；第二阶段只在这些文章内选章节 */
    selectedArticleIds: string[]
    /** 因同篇文章过多或内容高度相似而被过滤的章节 */
    diversityDroppedKeys: string[]
    rerankApplied: boolean
    rerankStrategy: "external" | "local" | "local_fallback" | "skipped"
    rerankError?: string
    treeAttempted: boolean
    treeReason?: "complex_query" | "fast_recall_empty"
    retrievalScope: "focused_article" | "article_then_chapter" | "cross_kb_article_then_chapter"
    degraded: Partial<Record<RecallSource, string>>
    retrievalMs: number
    rerankMs: number
}

export type KnowledgeRecallResult = {
    candidates: KnowledgeCandidate[]
    diagnostics: RecallDiagnostics
}

export type KnowledgeRecallInput = {
    userId: number
    knowledgeBaseId: number
    query: string
    /** 复杂问题拆出的子查询（§34），会与主查询一起并行召回后融合 */
    subQueries?: string[]
    articleId?: number
    config?: Partial<RecallConfig>
    reranker?: Reranker
    signal?: AbortSignal
    /**
     * Tree 是一次昂贵的 LLM 导航：简单查询先走快速召回，仅在无结果时 fallback；
     * 多步/复杂查询可 always 并行执行，off 供诊断与降级。
     */
    treeMode?: "always" | "fallback" | "off"
}

export async function recallKnowledgeCandidates(input: KnowledgeRecallInput): Promise<KnowledgeRecallResult> {
    await assertKnowledgeBaseOwner(getDb(), input.userId, input.knowledgeBaseId)
    return await recallModernKnowledge({
        ...input,
        retrievalScope: input.articleId != null ? "focused_article" : "article_then_chapter",
    })
}

/**
 * 未锁定具体知识库时的跨库混合召回。
 *
 * 旧路径只取最近 500 条 Wiki/文章后在 JS 里打分，较老但高度相关的内容永远召不回。
 * 这里直接复用 Wiki Tree 的全局向量索引与 GIN/n-gram 候选池，并继续尊重 user_id
 * 权限边界。向量只做一次全局查询，不按知识库循环；昂贵的 Tree LLM 仍不跨库强跑。
 */
export async function recallKnowledgeCandidatesAcrossKbs(input: {
    userId: number
    query: string
    subQueries?: string[]
    limit?: number
    config?: Partial<RecallConfig>
    reranker?: Reranker
    signal?: AbortSignal
}): Promise<KnowledgeRecallResult> {
    return await recallModernKnowledge({
        ...input,
        config: {
            ...input.config,
            ...(input.limit != null ? { finalTopK: input.limit } : {}),
        },
        treeMode: "off",
        retrievalScope: "cross_kb_article_then_chapter",
    })
}

type ModernRecallInput = {
    userId: number
    query: string
    subQueries?: string[]
    knowledgeBaseId?: number
    articleId?: number
    config?: Partial<RecallConfig>
    reranker?: Reranker
    signal?: AbortSignal
    treeMode?: "always" | "fallback" | "off"
    retrievalScope: RecallDiagnostics["retrievalScope"]
}

type IndexedCandidate = { candidate: KnowledgeCandidate; content: string }

function candidateFromChunk(hit: ArticleKnowledgeSearchHit): IndexedCandidate {
    return {
        candidate: {
            nodeKey: hit.candidateKey,
            candidateKey: hit.candidateKey,
            candidateKind: "chunk",
            chunkId: hit.chunkId,
            articleId: hit.articleId,
            knowledgeBaseId: hit.knowledgeBaseId,
            title: hit.title,
            path: hit.path,
            summary: hit.summary,
            ...(hit.matchedSource === "question" ? { reason: `推荐问题命中：${hit.matchedContent}` } : {}),
            recallSources: [],
        },
        content: hit.contentMd,
    }
}

function candidateFromWiki(hit: WikiKnowledgeSearchHit): IndexedCandidate {
    return {
        candidate: {
            nodeKey: hit.candidateKey,
            candidateKey: hit.candidateKey,
            candidateKind: "wiki",
            pageKey: hit.pageKey,
            pageKind: hit.kind,
            aliases: hit.aliases,
            articleId: hit.articleId,
            knowledgeBaseId: hit.knowledgeBaseId,
            title: hit.title,
            summary: hit.summary,
            reason: `${hit.kind} Wiki 页面命中`,
            recallSources: [],
        },
        content: hit.contentMd,
    }
}

function candidateFromTree(hit: TreeRetrievalHit | Bm25Node, candidateKey: string): IndexedCandidate {
    const path = "path" in hit && hit.path
        ? String(hit.path).split(/\s*(?:›|\/)\s*/).filter(Boolean)
        : undefined
    return {
        candidate: {
            nodeKey: hit.nodeKey,
            candidateKey,
            candidateKind: "tree",
            articleId: hit.articleId,
            knowledgeBaseId: hit.knowledgeBaseId,
            title: hit.title,
            ...(path ? { path } : {}),
            ...(hit.summary ? { summary: hit.summary } : {}),
            ...( "reason" in hit && hit.reason ? { reason: hit.reason } : {}),
            recallSources: [],
        },
        content: hit.contentMd,
    }
}

function splitSearchGroups(
    results: Array<PromiseSettledResult<ArticleKnowledgeSearchGroups>>,
    degraded: Partial<Record<RecallSource, string>>,
    chunkSource: RecallSource,
    questionSource: RecallSource,
) {
    const chunk: ArticleKnowledgeSearchHit[][] = []
    const question: ArticleKnowledgeSearchHit[][] = []
    for (const result of results) {
        if (result.status === "fulfilled") {
            chunk.push(result.value.chunk)
            question.push(result.value.question)
            continue
        }
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
        degraded[chunkSource] = reason
        degraded[questionSource] = reason
    }
    return { chunk, question }
}

function addRecallGroup(
    groups: Array<Array<{ nodeKey: string; score?: number }>>,
    sources: RecallSource[],
    source: RecallSource,
    hits: Array<{ candidateKey: string; score?: number }>,
) {
    if (hits.length === 0) return
    groups.push(hits.map((hit) => ({ nodeKey: hit.candidateKey, ...(hit.score == null ? {} : { score: hit.score }) })))
    sources.push(source)
}

async function recallModernKnowledge(input: ModernRecallInput): Promise<KnowledgeRecallResult> {
    const startedAt = Date.now()
    const flags = readAgentFeatureFlags()
    const config = resolveRecallConfig(input.config)
    const queries = [input.query, ...(input.subQueries ?? [])]
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, 4)
    const degraded: Partial<Record<RecallSource, string>> = {}
    const candidateIndex = new Map<string, IndexedCandidate>()

    const [vectorSettled, lexicalSettled, wikiSettled] = await Promise.all([
        settleAll(queries.map((query) => semanticSearchArticleKnowledge({
            userId: input.userId,
            ...(input.knowledgeBaseId != null ? { knowledgeBaseId: input.knowledgeBaseId } : {}),
            ...(input.articleId != null ? { articleId: input.articleId } : {}),
            query,
            limit: config.vectorTopK,
        }))),
        flags.bm25
            ? settleAll(queries.map((query) => lexicalSearchArticleKnowledge({
                userId: input.userId,
                ...(input.knowledgeBaseId != null ? { knowledgeBaseId: input.knowledgeBaseId } : {}),
                ...(input.articleId != null ? { articleId: input.articleId } : {}),
                query,
                limit: config.bm25TopK,
            })))
            : Promise.resolve<Array<PromiseSettledResult<ArticleKnowledgeSearchGroups>>>([]),
        settleAll(queries.map((query) => searchKnowledgeWikiPages({
            userId: input.userId,
            ...(input.knowledgeBaseId != null ? { knowledgeBaseId: input.knowledgeBaseId } : {}),
            query,
            limit: config.bm25TopK,
        }))),
    ])

    const vector = splitSearchGroups(vectorSettled, degraded, "chunk_vector", "question_vector")
    const lexical = splitSearchGroups(lexicalSettled, degraded, "chunk_bm25", "question_bm25")
    const wiki = collect(wikiSettled, degraded, "wiki")

    for (const group of [...vector.chunk, ...lexical.chunk]) {
        for (const hit of group) candidateIndex.set(hit.candidateKey, candidateFromChunk(hit))
    }
    for (const group of [...vector.question, ...lexical.question]) {
        for (const hit of group) {
            if (!candidateIndex.has(hit.candidateKey)) candidateIndex.set(hit.candidateKey, candidateFromChunk(hit))
            else {
                const indexed = candidateIndex.get(hit.candidateKey)
                if (indexed && !indexed.candidate.reason) indexed.candidate.reason = `推荐问题命中：${hit.matchedContent}`
            }
        }
    }
    for (const group of wiki) {
        for (const hit of group) candidateIndex.set(hit.candidateKey, candidateFromWiki(hit))
    }

    const groups: Array<Array<{ nodeKey: string; score?: number }>> = []
    const sources: RecallSource[] = []
    for (const group of vector.chunk) addRecallGroup(groups, sources, "chunk_vector", group)
    for (const group of vector.question) addRecallGroup(groups, sources, "question_vector", group)
    for (const group of lexical.chunk) addRecallGroup(groups, sources, "chunk_bm25", group)
    for (const group of lexical.question) addRecallGroup(groups, sources, "question_bm25", group)
    for (const group of wiki) addRecallGroup(groups, sources, "wiki", group)

    let treeAttempted = false
    let treeResults: TreeRetrievalHit[][] = []
    let legacyVectorResults: TreeRetrievalHit[][] = []
    let legacyBm25Results: Bm25RecallHit[][] = []

    // 存量兼容：只有新版分片/问题/Wiki 三路全空时，才回退旧 Wiki Tree。
    if (!hasAnyHit(groups)) {
        if (input.knowledgeBaseId != null) {
            const [vectorResults, bm25Results] = await Promise.all([
                settleAll(queries.map((query) => semanticSearchTreeNodes({
                    userId: input.userId,
                    knowledgeBaseId: input.knowledgeBaseId!,
                    query,
                    limit: config.vectorTopK,
                    ...(input.articleId != null ? { articleId: input.articleId } : {}),
                    maxContentChars: 600,
                }))).then((results) => collect(results, degraded, "vector")),
                flags.bm25
                    ? settleAll(queries.map((query) => bm25RecallTreeNodes({
                        userId: input.userId,
                        knowledgeBaseId: input.knowledgeBaseId!,
                        query,
                        limit: config.bm25TopK,
                        ...(input.articleId != null ? { articleId: input.articleId } : {}),
                    }))).then((results) => collect(results, degraded, "bm25"))
                    : Promise.resolve<Bm25RecallHit[][]>([]),
            ])
            legacyVectorResults = vectorResults
            legacyBm25Results = bm25Results
            const treeMode = input.treeMode ?? "fallback"
            if (treeMode === "always" || (treeMode === "fallback" && !hasAnyHit(vectorResults) && !hasAnyHit(bm25Results))) {
                treeAttempted = true
                treeResults = await runTreeRecall(input as KnowledgeRecallInput, config, queries[0] ?? input.query, degraded)
            }
            for (const group of [...treeResults, ...legacyVectorResults]) {
                for (const hit of group) {
                    const key = `tree:${hit.knowledgeBaseId}:${hit.nodeKey}`
                    candidateIndex.set(key, candidateFromTree(hit, key))
                }
            }
            for (const group of legacyBm25Results) {
                for (const hit of group) {
                    const key = `tree:${hit.node.knowledgeBaseId}:${hit.nodeKey}`
                    if (!candidateIndex.has(key)) candidateIndex.set(key, candidateFromTree(hit.node, key))
                }
            }
        } else {
            const [vectorResults, bm25Results] = await Promise.all([
                settleAll(queries.map((query) => semanticSearchTreeNodesAcrossKbs({
                    userId: input.userId,
                    query,
                    limit: config.vectorTopK,
                    maxContentChars: 600,
                }))).then((results) => collect(results, degraded, "vector")),
                flags.bm25
                    ? settleAll(queries.map((query) => bm25RecallTreeNodesAcrossKbs({
                        userId: input.userId,
                        query,
                        limit: config.bm25TopK,
                    }))).then((results) => collect(results, degraded, "bm25"))
                    : Promise.resolve<Bm25RecallHit[][]>([]),
            ])
            legacyVectorResults = vectorResults
            legacyBm25Results = bm25Results
            for (const group of legacyVectorResults) {
                for (const hit of group) {
                    const key = `tree:${hit.knowledgeBaseId}:${hit.nodeKey}`
                    candidateIndex.set(key, candidateFromTree(hit, key))
                }
            }
            for (const group of legacyBm25Results) {
                for (const hit of group) {
                    const key = `tree:${hit.node.knowledgeBaseId}:${hit.nodeKey}`
                    if (!candidateIndex.has(key)) candidateIndex.set(key, candidateFromTree(hit.node, key))
                }
            }
        }

        for (const group of treeResults) {
            groups.push(group.map((hit) => ({ nodeKey: `tree:${hit.knowledgeBaseId}:${hit.nodeKey}` })))
            sources.push("tree")
        }
        for (const group of legacyVectorResults) {
            groups.push(group.map((hit) => ({ nodeKey: `tree:${hit.knowledgeBaseId}:${hit.nodeKey}` })))
            sources.push("vector")
        }
        for (const group of legacyBm25Results) {
            groups.push(group.map((hit) => ({ nodeKey: `tree:${hit.node.knowledgeBaseId}:${hit.nodeKey}`, score: hit.score })))
            sources.push("bm25")
        }
    }

    const fused = flags.rrf
        ? reciprocalRankFusion(
            groups.map((group, index) => toRecallHits(sources[index], group)),
            { k: config.rrfK, topK: config.fusionTopK },
        )
        : appendFallback(groups, sources, config.fusionTopK)
    const broadCandidates = fused.flatMap((item) => {
        const indexed = candidateIndex.get(item.nodeKey)
        if (!indexed) return []
        return [{ ...indexed.candidate, score: item.fusedScore, recallSources: item.recallSources }]
    })
    const articleStage = selectArticleStage(broadCandidates, {
        articleTopK: input.articleId != null ? 1 : config.articleTopK,
        perArticleTopK: config.perArticleTopK,
        ...(input.articleId != null ? { focusedArticleId: String(input.articleId) } : {}),
    })
    const reranker = input.reranker ?? createReranker()
    const reranked = await rerankAdaptively(
        reranker,
        input.query,
        articleStage.candidates.slice(0, config.rerankTopK).map((candidate) => ({
            ...candidate,
            content: candidateIndex.get(knowledgeCandidateKey(candidate))?.content.slice(0, 1_200),
        })),
        { topN: Math.max(config.finalTopK, config.maxPerArticle * Math.max(articleStage.articleIds.length, 1)), ...(input.signal ? { signal: input.signal } : {}) },
    )
    const diversified = selectDiverseCandidates(
        reranked.items,
        config.finalTopK,
        input.articleId != null ? config.finalTopK : config.maxPerArticle,
    )
    const finalCandidates = diversified.items.map((item) => {
        const candidate: Record<string, unknown> = { ...item }
        delete candidate.content
        return candidate as unknown as KnowledgeCandidate
    }).slice(0, config.finalTopK)

    if (finalCandidates.length < config.finalTopK) {
        for (const candidate of articleStage.candidates) {
            if (finalCandidates.length >= config.finalTopK) break
            if (finalCandidates.some((item) => knowledgeCandidateKey(item) === knowledgeCandidateKey(candidate))) continue
            if (!canAppendCandidate(finalCandidates, candidate, input.articleId != null ? config.finalTopK : config.maxPerArticle)) continue
            finalCandidates.push(candidate)
        }
    }

    const chunkVectorKeys = vector.chunk.flatMap((group) => group.map((hit) => hit.candidateKey))
    const questionVectorKeys = vector.question.flatMap((group) => group.map((hit) => hit.candidateKey))
    const chunkBm25Keys = lexical.chunk.flatMap((group) => group.map((hit) => hit.candidateKey))
    const questionBm25Keys = lexical.question.flatMap((group) => group.map((hit) => hit.candidateKey))
    const wikiKeys = wiki.flatMap((group) => group.map((hit) => hit.candidateKey))
    const treeKeys = treeResults.flatMap((group) => group.map((hit) => hit.nodeKey))
    const legacyVectorKeys = legacyVectorResults.flatMap((group) => group.map((hit) => (
        input.knowledgeBaseId == null ? `${hit.knowledgeBaseId}:${hit.nodeKey}` : hit.nodeKey
    )))
    const legacyBm25Keys = legacyBm25Results.flatMap((group) => group.map((hit) => (
        input.knowledgeBaseId == null ? `${hit.node.knowledgeBaseId}:${hit.nodeKey}` : hit.nodeKey
    )))

    return {
        candidates: finalCandidates,
        diagnostics: {
            query: input.query,
            rewrittenQueries: input.subQueries ?? [],
            treeKeys,
            vectorKeys: [...chunkVectorKeys, ...questionVectorKeys, ...legacyVectorKeys],
            bm25Keys: [...chunkBm25Keys, ...questionBm25Keys, ...legacyBm25Keys],
            chunkVectorKeys,
            questionVectorKeys,
            chunkBm25Keys,
            questionBm25Keys,
            wikiKeys,
            fusionKeys: fused.map((item) => item.nodeKey),
            finalKeys: finalCandidates.map(knowledgeCandidateKey),
            selectedArticleIds: articleStage.articleIds,
            diversityDroppedKeys: diversified.droppedKeys,
            rerankApplied: reranked.applied,
            rerankStrategy: reranked.strategy,
            ...(reranked.error ? { rerankError: reranked.error } : {}),
            treeAttempted,
            ...(treeAttempted ? { treeReason: "fast_recall_empty" as const } : {}),
            retrievalScope: input.retrievalScope,
            degraded,
            retrievalMs: Date.now() - startedAt,
            rerankMs: reranked.durationMs,
        },
    }
}

// ---------------------------------------------------------------------------
// BM25 召回
// ---------------------------------------------------------------------------

type Bm25Node = {
    nodeKey: string
    articleId: string
    knowledgeBaseId: string
    title: string
    summary: string | null
    contentMd: string
    path?: string
}

type Bm25RecallHit = { nodeKey: string; score: number; node: Bm25Node }

/** BM25 候选池上限：先用索引/条件收窄，再在应用层精确打分 */
const BM25_POOL_LIMIT = 400

export async function bm25RecallTreeNodes(input: {
    userId: number
    knowledgeBaseId: number
    query: string
    limit: number
    articleId?: number
}): Promise<Bm25RecallHit[]> {
    const tokens = buildQueryTokens(input.query)
    if (tokens.length === 0) return []

    const pool = await loadBm25Pool(input, tokens)
    if (pool.length === 0) return []

    const hits = bm25Search(
        pool.map((node) => ({
            id: node.nodeKey,
            title: node.title,
            summary: node.summary,
            content: node.contentMd,
        })),
        input.query,
        {
            weights: resolveBm25FieldWeights(),
            topK: input.limit,
            corpusSize: pool.length,
        },
    )

    const byKey = new Map(pool.map((node) => [node.nodeKey, node]))
    return hits.flatMap((hit) => {
        const node = byKey.get(hit.id)
        return node ? [{ nodeKey: hit.id, score: hit.score, node }] : []
    })
}

export async function bm25RecallTreeNodesAcrossKbs(input: {
    userId: number
    query: string
    limit: number
}): Promise<Bm25RecallHit[]> {
    const tokens = buildQueryTokens(input.query)
    if (tokens.length === 0) return []
    const pool = await loadBm25Pool({ userId: input.userId }, tokens)
    if (pool.length === 0) return []

    const hits = bm25Search(
        pool.map((node) => ({
            id: crossNodeKey(node),
            title: node.title,
            summary: node.summary,
            content: node.contentMd,
        })),
        input.query,
        {
            weights: resolveBm25FieldWeights(),
            topK: input.limit,
            corpusSize: pool.length,
        },
    )
    const byKey = new Map(pool.map((node) => [crossNodeKey(node), node]))
    return hits.flatMap((hit) => {
        const node = byKey.get(hit.id)
        return node ? [{ nodeKey: node.nodeKey, score: hit.score, node }] : []
    })
}

/**
 * 候选池加载：
 * 1. Postgres 且已建全文索引 → 用 GIN 索引先筛（快，且能覆盖大库）；
 * 2. 索引不存在（迁移未执行）或 SQLite → 退回按知识库整表取，上限保护。
 * 两条路径的打分逻辑完全一致，只影响召回范围。
 */
async function loadBm25Pool(
    input: { userId: number; knowledgeBaseId?: number; articleId?: number },
    tokens: string[],
): Promise<Bm25Node[]> {
    const db = getDb()
    if (!isSqliteDatabase()) {
        const tsquery = buildTsQuery(tokens)
        if (tsquery) {
            try {
                const rows = await db.execute(sql`
                    select node_key, article_id, knowledge_base_id, title, summary, content_md
                    from petrichor_kb_wiki_tree_node
                    where user_id = ${input.userId}
                      ${input.knowledgeBaseId != null
                          ? sql`and knowledge_base_id = ${input.knowledgeBaseId}`
                          : sql``}
                      ${input.articleId != null ? sql`and article_id = ${input.articleId}` : sql``}
                      and search_vector @@ to_tsquery('simple', ${tsquery})
                    order by ts_rank_cd(search_vector, to_tsquery('simple', ${tsquery})) desc
                    limit ${BM25_POOL_LIMIT}
                `)
                const list = toRows(rows)
                if (list.length > 0) return list.map(mapRow)
            } catch {
                // 索引列不存在（迁移未执行）→ 走整表兜底，不影响功能
            }
        }
    }

    // 迁移尚未回填 search_*_tokens 时，不能按“前 N 行”兜底，否则较老内容永远
    // 没机会进入候选池。改用原文字段的 n-gram LIKE 条件从全表筛出真正命中的行。
    const lexicalConditions = tokens.slice(0, 16).flatMap((token) => {
        const pattern = `%${escapeLike(token)}%`
        return [
            like(knowledgeBaseWikiTreeNodes.title, pattern),
            like(knowledgeBaseWikiTreeNodes.summary, pattern),
            like(knowledgeBaseWikiTreeNodes.contentMd, pattern),
        ]
    })
    const lexical = or(...lexicalConditions)
    const rows = await db
        .select({
            nodeKey: knowledgeBaseWikiTreeNodes.nodeKey,
            articleId: knowledgeBaseWikiTreeNodes.articleId,
            knowledgeBaseId: knowledgeBaseWikiTreeNodes.knowledgeBaseId,
            title: knowledgeBaseWikiTreeNodes.title,
            summary: knowledgeBaseWikiTreeNodes.summary,
            contentMd: knowledgeBaseWikiTreeNodes.contentMd,
        })
        .from(knowledgeBaseWikiTreeNodes)
        .where(and(
            eq(knowledgeBaseWikiTreeNodes.userId, input.userId),
            ...(input.knowledgeBaseId != null
                ? [eq(knowledgeBaseWikiTreeNodes.knowledgeBaseId, input.knowledgeBaseId)]
                : []),
            ...(input.articleId != null ? [eq(knowledgeBaseWikiTreeNodes.articleId, input.articleId)] : []),
            ...(lexical ? [lexical] : []),
        ))
        .limit(BM25_POOL_LIMIT)

    return rows.map((row) => ({
        nodeKey: row.nodeKey,
        articleId: String(row.articleId),
        knowledgeBaseId: String(row.knowledgeBaseId),
        title: row.title,
        summary: row.summary,
        contentMd: row.contentMd,
    }))
}

function toRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>
    const rows = (result as { rows?: unknown })?.rows
    return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
}

function mapRow(row: Record<string, unknown>): Bm25Node {
    return {
        nodeKey: String(row.node_key ?? ""),
        articleId: String(row.article_id ?? ""),
        knowledgeBaseId: String(row.knowledge_base_id ?? ""),
        title: String(row.title ?? ""),
        summary: row.summary == null ? null : String(row.summary),
        contentMd: String(row.content_md ?? ""),
    }
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

async function settleAll<T>(promises: Array<Promise<T>>): Promise<Array<PromiseSettledResult<T>>> {
    return await Promise.allSettled(promises)
}

async function runTreeRecall(
    input: KnowledgeRecallInput,
    config: RecallConfig,
    query: string,
    degraded: Partial<Record<RecallSource, string>>,
): Promise<TreeRetrievalHit[][]> {
    // Tree 只对主查询跑一次。子查询用于扩展词面，交给便宜的 Vector/BM25 即可。
    const settled = await settleAll([
        withTimeout(
            (signal) => retrieveTreeNodesForAgent({
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                query,
                limit: config.treeTopK,
                ...(input.articleId != null ? { articleId: input.articleId } : {}),
                maxContentChars: 600,
                signal,
            }),
            config.treeTimeoutMs,
            "tree 召回超时",
            input.signal,
        ),
    ])
    return collect(settled, degraded, "tree")
}

/** 单路召回超时保护：超时必须真正 abort 底层 LLM，不能只停止等待留下僵尸请求。 */
async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    ms: number,
    message: string,
    externalSignal?: AbortSignal,
): Promise<T> {
    const controller = new AbortController()
    const abortFromOutside = () => controller.abort()
    externalSignal?.addEventListener("abort", abortFromOutside, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            run(controller.signal),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    controller.abort()
                    reject(new Error(message))
                }, ms)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
        externalSignal?.removeEventListener("abort", abortFromOutside)
    }
}

function hasAnyHit<T>(groups: T[][]): boolean {
    return groups.some((group) => group.length > 0)
}

function collect<T>(
    results: Array<PromiseSettledResult<T[]>>,
    degraded: Partial<Record<RecallSource, string>>,
    source: RecallSource,
): T[][] {
    const out: T[][] = []
    for (const result of results) {
        if (result.status === "fulfilled") {
            out.push(result.value)
            continue
        }
        degraded[source] = result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
    return out
}

function crossNodeKey(node: Pick<Bm25Node, "knowledgeBaseId" | "nodeKey">): string {
    return `${node.knowledgeBaseId}:${node.nodeKey}`
}

function crossCandidateKey(candidate: Pick<KnowledgeCandidate, "knowledgeBaseId" | "nodeKey" | "candidateKey">): string {
    return candidate.candidateKey ?? `${candidate.knowledgeBaseId}:${candidate.nodeKey}`
}

function knowledgeCandidateKey(candidate: Pick<KnowledgeCandidate, "knowledgeBaseId" | "nodeKey" | "candidateKey">): string {
    return candidate.candidateKey ?? `${candidate.knowledgeBaseId}:${candidate.nodeKey}`
}

type ArticleStageOptions = {
    articleTopK: number
    perArticleTopK: number
    focusedArticleId?: string
}

/**
 * 第一阶段把章节命中按文章聚合，第二阶段按文章轮询取章节。
 * 文章得分用「最佳章节 + 其余章节的衰减贡献」，既不会只看一个偶然命中，
 * 也不会让章节特别多的长文章单纯靠数量胜出。
 */
export function selectArticleStage(
    candidates: KnowledgeCandidate[],
    options: ArticleStageOptions,
): { candidates: KnowledgeCandidate[]; articleIds: string[] } {
    const grouped = new Map<string, Array<{ candidate: KnowledgeCandidate; index: number }>>()
    candidates.forEach((candidate, index) => {
        if (options.focusedArticleId && candidate.articleId !== options.focusedArticleId) return
        const key = articleCandidateKey(candidate)
        grouped.set(key, [...(grouped.get(key) ?? []), { candidate, index }])
    })

    const rankedArticles = [...grouped.entries()]
        .map(([key, items]) => {
            const scores = items
                .map((item) => item.candidate.score ?? 0)
                .sort((left, right) => right - left)
            const score = (scores[0] ?? 0)
                + (scores[1] ?? 0) * 0.35
                + (scores[2] ?? 0) * 0.15
                + Math.max(...items.map((item) => item.candidate.recallSources.length)) * 0.000001
            return { key, items, score, firstIndex: Math.min(...items.map((item) => item.index)) }
        })
        .sort((left, right) => right.score - left.score || left.firstIndex - right.firstIndex)
        .slice(0, Math.max(1, options.articleTopK))

    const balanced: KnowledgeCandidate[] = []
    for (let offset = 0; offset < Math.max(1, options.perArticleTopK); offset += 1) {
        for (const article of rankedArticles) {
            const item = article.items[offset]
            if (item) balanced.push(item.candidate)
        }
    }

    return {
        candidates: balanced,
        articleIds: rankedArticles.map((item) => item.key),
    }
}

type CandidateWithContent = KnowledgeCandidate & { content?: string | null }

/** 最终候选同时限制单篇占比，并过滤标题/摘要/正文高度相似的重复章节。 */
export function selectDiverseCandidates<T extends CandidateWithContent>(
    candidates: T[],
    limit: number,
    maxPerArticle: number,
): { items: T[]; droppedKeys: string[] } {
    const items: T[] = []
    const droppedKeys: string[] = []
    for (const candidate of candidates) {
        if (items.length >= limit) break
        if (!canAppendCandidate(items, candidate, maxPerArticle)) {
            droppedKeys.push(crossCandidateKey(candidate))
            continue
        }
        items.push(candidate)
    }
    return { items, droppedKeys }
}

function canAppendCandidate<T extends CandidateWithContent>(
    selected: T[],
    candidate: CandidateWithContent,
    maxPerArticle: number,
): boolean {
    const articleKey = articleCandidateKey(candidate)
    if (selected.filter((item) => articleCandidateKey(item) === articleKey).length >= maxPerArticle) {
        return false
    }
    return !selected.some((item) => candidateSimilarity(item, candidate) >= 0.88)
}

function articleCandidateKey(candidate: Pick<KnowledgeCandidate, "knowledgeBaseId" | "articleId" | "nodeKey" | "candidateKey">): string {
    return candidate.articleId
        ? `${candidate.knowledgeBaseId}:${candidate.articleId}`
        : candidate.candidateKey ?? `${candidate.knowledgeBaseId}:node:${candidate.nodeKey}`
}

function candidateSimilarity(left: CandidateWithContent, right: CandidateWithContent): number {
    const leftTitle = normalizeSearchText(left.title)
    const rightTitle = normalizeSearchText(right.title)
    if (leftTitle && leftTitle === rightTitle) return 1

    const leftTokens = new Set(buildQueryTokens(candidateText(left)))
    const rightTokens = new Set(buildQueryTokens(candidateText(right)))
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0
    let intersection = 0
    for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
    const union = leftTokens.size + rightTokens.size - intersection
    return union === 0 ? 0 : intersection / union
}

function candidateText(candidate: CandidateWithContent): string {
    return [candidate.title, candidate.summary ?? "", candidate.content?.slice(0, 800) ?? ""]
        .filter(Boolean)
        .join("\n")
}

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "").trim()
}

/** RRF 关闭时的兜底：按召回源顺序去重拼接 */
function appendFallback(
    groups: Array<Array<{ nodeKey: string; score?: number }>>,
    sources: RecallSource[],
    topK: number,
): FusedCandidate[] {
    const seen = new Map<string, FusedCandidate>()
    groups.forEach((group, groupIndex) => {
        const source = sources[groupIndex]
        group.forEach((item, index) => {
            const existing = seen.get(item.nodeKey)
            if (existing) {
                if (!existing.recallSources.includes(source)) existing.recallSources.push(source)
                return
            }
            seen.set(item.nodeKey, {
                nodeKey: item.nodeKey,
                fusedScore: 1 / (index + 1),
                recallSources: [source],
                ranks: { [source]: index + 1 },
                scores: item.score == null ? {} : { [source]: item.score },
            })
        })
    })
    return [...seen.values()].slice(0, topK)
}
