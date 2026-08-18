import { and, eq, like, or, sql } from "drizzle-orm"
import { resolveBm25FieldWeights, resolveRecallConfig, readAgentFeatureFlags, type RecallConfig } from "@/server/assistant/agent-runtime/config"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { knowledgeBaseWikiTreeNodes } from "@/server/db/schema"
import { bm25Search } from "@/server/retrieval/bm25"
import { reciprocalRankFusion, toRecallHits, type FusedCandidate, type RecallSource } from "@/server/retrieval/fusion"
import { createReranker, rerankWithFallback, type Reranker } from "@/server/retrieval/reranker"
import { buildQueryTokens, buildTsQuery } from "@/server/retrieval/tokenize"
import { assertKnowledgeBaseOwner } from "./wiki-agent-logic"
import { retrieveTreeNodesForAgent, semanticSearchTreeNodes, type TreeRetrievalHit } from "./wiki-tree"

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
    fusionKeys: string[]
    finalKeys: string[]
    rerankApplied: boolean
    rerankError?: string
    treeAttempted: boolean
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
    const startedAt = Date.now()
    const flags = readAgentFeatureFlags()
    const config = resolveRecallConfig(input.config)
    const queries = [input.query, ...(input.subQueries ?? [])].filter((q) => q.trim()).slice(0, 4)

    await assertKnowledgeBaseOwner(getDb(), input.userId, input.knowledgeBaseId)

    const degraded: Partial<Record<RecallSource, string>> = {}
    const nodeIndex = new Map<string, TreeRetrievalHit | Bm25Node>()

    // ---- 快速召回优先；任意一路失败只记降级原因 -----------------------------
    const vectorPromise = settleAll(queries.map((query) =>
            semanticSearchTreeNodes({
                userId: input.userId,
                knowledgeBaseId: input.knowledgeBaseId,
                query,
                limit: config.vectorTopK,
                ...(input.articleId != null ? { articleId: input.articleId } : {}),
                maxContentChars: 600,
            }),
        )).then((r) => collect(r, degraded, "vector"))
    const bm25Promise = flags.bm25
        ? settleAll(queries.map((query) =>
                bm25RecallTreeNodes({
                    userId: input.userId,
                    knowledgeBaseId: input.knowledgeBaseId,
                    query,
                    limit: config.bm25TopK,
                    ...(input.articleId != null ? { articleId: input.articleId } : {}),
                }),
            )).then((r) => collect(r, degraded, "bm25"))
        : Promise.resolve<Bm25RecallHit[][]>([])

    const treeMode = input.treeMode ?? "always"
    let treeAttempted = treeMode === "always"
    const treePromise = treeMode === "always"
        ? runTreeRecall(input, config, queries[0] ?? input.query, degraded)
        : Promise.resolve<TreeRetrievalHit[][]>([])

    const [vectorResults, bm25Results, initialTreeResults] = await Promise.all([
        vectorPromise,
        bm25Promise,
        treePromise,
    ])
    let treeResults = initialTreeResults

    // 简单问题只在 Vector + BM25 都没有候选时才付 Tree LLM 的成本。
    if (treeMode === "fallback" && !hasAnyHit(vectorResults) && !hasAnyHit(bm25Results)) {
        treeAttempted = true
        treeResults = await runTreeRecall(input, config, queries[0] ?? input.query, degraded)
    }

    for (const group of [...treeResults, ...vectorResults]) {
        for (const hit of group) nodeIndex.set(hit.nodeKey, hit)
    }
    for (const group of bm25Results) {
        for (const hit of group) if (!nodeIndex.has(hit.nodeKey)) nodeIndex.set(hit.nodeKey, hit.node)
    }

    const treeKeys = flatKeys(treeResults)
    const vectorKeys = flatKeys(vectorResults)
    const bm25Keys = bm25Results.flatMap((group) => group.map((hit) => hit.nodeKey))

    // ---- 融合 -------------------------------------------------------------
    const groups: Array<Array<{ nodeKey: string; score?: number }>> = []
    const sources: RecallSource[] = []
    for (const group of treeResults) {
        groups.push(group.map((hit) => ({ nodeKey: hit.nodeKey })))
        sources.push("tree")
    }
    for (const group of vectorResults) {
        groups.push(group.map((hit) => ({ nodeKey: hit.nodeKey })))
        sources.push("vector")
    }
    for (const group of bm25Results) {
        groups.push(group.map((hit) => ({ nodeKey: hit.nodeKey, score: hit.score })))
        sources.push("bm25")
    }

    const fused: FusedCandidate[] = flags.rrf
        ? reciprocalRankFusion(
            groups.map((group, index) => toRecallHits(sources[index], group)),
            { k: config.rrfK, topK: config.fusionTopK },
        )
        : appendFallback(groups, sources, config.fusionTopK)

    // ---- 重排 -------------------------------------------------------------
    const preRerank = fused.map((item) => toCandidate(item, nodeIndex, input.knowledgeBaseId))
    const reranker = input.reranker ?? createReranker()
    const reranked = await rerankWithFallback(
        reranker,
        input.query,
        preRerank.slice(0, config.rerankTopK).map((candidate) => ({
            ...candidate,
            content: readContent(nodeIndex.get(candidate.nodeKey)),
        })),
        { topN: config.finalTopK, ...(input.signal ? { signal: input.signal } : {}) },
    )

    // rerank 输入里带了 content 供打分，回给调用方时去掉——search 只返回定位信息（§30）
    const finalCandidates: KnowledgeCandidate[] = reranked.items
        .map((item) => {
            const candidate: Record<string, unknown> = { ...item }
            delete candidate.content
            return candidate as unknown as KnowledgeCandidate
        })
        .slice(0, config.finalTopK)

    // rerank 未生效时补齐到 finalTopK（rerankTopK 可能小于 finalTopK）
    if (!reranked.applied && finalCandidates.length < config.finalTopK) {
        for (const candidate of preRerank) {
            if (finalCandidates.length >= config.finalTopK) break
            if (finalCandidates.some((item) => item.nodeKey === candidate.nodeKey)) continue
            finalCandidates.push(candidate)
        }
    }

    return {
        candidates: finalCandidates,
        diagnostics: {
            query: input.query,
            rewrittenQueries: input.subQueries ?? [],
            treeKeys,
            vectorKeys,
            bm25Keys,
            fusionKeys: fused.map((item) => item.nodeKey),
            finalKeys: finalCandidates.map((item) => item.nodeKey),
            rerankApplied: reranked.applied,
            ...(reranked.error ? { rerankError: reranked.error } : {}),
            treeAttempted,
            degraded,
            retrievalMs: Date.now() - startedAt,
            rerankMs: reranked.durationMs,
        },
    }
}

/**
 * 未锁定具体知识库时的跨库 BM25 召回。
 *
 * 旧路径只取最近 500 条 Wiki/文章后在 JS 里打分，较老但高度相关的内容永远召不回。
 * 这里直接复用 tree node 的 GIN/n-gram 候选池，并继续尊重 user_id 权限边界；
 * 不跨所有库强跑向量与 Tree LLM，符合 §95/§96 的成本约束。
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
    const startedAt = Date.now()
    const flags = readAgentFeatureFlags()
    const config = resolveRecallConfig({
        ...input.config,
        ...(input.limit != null ? { finalTopK: input.limit } : {}),
    })
    const queries = [input.query, ...(input.subQueries ?? [])]
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, 4)
    const degraded: Partial<Record<RecallSource, string>> = {}

    const bm25Results = flags.bm25
        ? await settleAll(queries.map((query) => bm25RecallTreeNodesAcrossKbs({
            userId: input.userId,
            query,
            limit: config.bm25TopK,
        }))).then((results) => collect(results, degraded, "bm25"))
        : []

    const nodeIndex = new Map<string, Bm25Node>()
    const groups = bm25Results.map((group) => group.map((hit) => {
        const key = crossNodeKey(hit.node)
        nodeIndex.set(key, hit.node)
        return { nodeKey: key, score: hit.score }
    }))
    const sources: RecallSource[] = groups.map(() => "bm25")
    const fused = flags.rrf
        ? reciprocalRankFusion(
            groups.map((group) => toRecallHits("bm25", group)),
            { k: config.rrfK, topK: config.fusionTopK },
        )
        : appendFallback(groups, sources, config.fusionTopK)

    const preRerank: KnowledgeCandidate[] = fused.flatMap((item) => {
        const node = nodeIndex.get(item.nodeKey)
        if (!node) return []
        return [{
            nodeKey: node.nodeKey,
            articleId: node.articleId,
            knowledgeBaseId: node.knowledgeBaseId,
            title: node.title,
            ...(node.summary ? { summary: node.summary } : {}),
            score: item.fusedScore,
            recallSources: item.recallSources,
        }]
    })
    const reranker = input.reranker ?? createReranker()
    const reranked = await rerankWithFallback(
        reranker,
        input.query,
        preRerank.slice(0, config.rerankTopK).map((candidate) => ({
            ...candidate,
            content: nodeIndex.get(crossCandidateKey(candidate))?.contentMd.slice(0, 1_200),
        })),
        { topN: config.finalTopK, ...(input.signal ? { signal: input.signal } : {}) },
    )
    const finalCandidates = reranked.items.map((item) => {
        const candidate: Record<string, unknown> = { ...item }
        delete candidate.content
        return candidate as unknown as KnowledgeCandidate
    }).slice(0, config.finalTopK)

    if (!reranked.applied && finalCandidates.length < config.finalTopK) {
        for (const candidate of preRerank) {
            if (finalCandidates.length >= config.finalTopK) break
            if (finalCandidates.some((item) => crossCandidateKey(item) === crossCandidateKey(candidate))) continue
            finalCandidates.push(candidate)
        }
    }

    return {
        candidates: finalCandidates,
        diagnostics: {
            query: input.query,
            rewrittenQueries: input.subQueries ?? [],
            treeKeys: [],
            vectorKeys: [],
            bm25Keys: fused.map((item) => item.nodeKey),
            fusionKeys: fused.map((item) => item.nodeKey),
            finalKeys: finalCandidates.map(crossCandidateKey),
            rerankApplied: reranked.applied,
            ...(reranked.error ? { rerankError: reranked.error } : {}),
            treeAttempted: false,
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

function flatKeys(groups: TreeRetrievalHit[][]): string[] {
    return [...new Set(groups.flatMap((group) => group.map((hit) => hit.nodeKey)))]
}

function crossNodeKey(node: Pick<Bm25Node, "knowledgeBaseId" | "nodeKey">): string {
    return `${node.knowledgeBaseId}:${node.nodeKey}`
}

function crossCandidateKey(candidate: Pick<KnowledgeCandidate, "knowledgeBaseId" | "nodeKey">): string {
    return `${candidate.knowledgeBaseId}:${candidate.nodeKey}`
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

function toCandidate(
    fused: FusedCandidate,
    index: Map<string, TreeRetrievalHit | Bm25Node>,
    knowledgeBaseId: number,
): KnowledgeCandidate {
    const node = index.get(fused.nodeKey)
    const isTreeHit = node != null && "path" in node && typeof node.path === "string"
    return {
        nodeKey: fused.nodeKey,
        articleId: node?.articleId ?? "",
        knowledgeBaseId: String(knowledgeBaseId),
        title: node?.title ?? fused.nodeKey,
        ...(isTreeHit && node.path ? { path: String(node.path).split(" / ").filter(Boolean) } : {}),
        ...(node && "summary" in node && node.summary ? { summary: String(node.summary) } : {}),
        score: fused.fusedScore,
        recallSources: fused.recallSources,
        ...(node && "reason" in node && node.reason ? { reason: String(node.reason) } : {}),
    }
}

function readContent(node: TreeRetrievalHit | Bm25Node | undefined): string | undefined {
    if (!node) return undefined
    if ("contentMd" in node && node.contentMd) return String(node.contentMd).slice(0, 1_200)
    return undefined
}
