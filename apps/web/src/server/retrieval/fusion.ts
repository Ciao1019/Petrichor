/**
 * 召回融合（§28）。
 *
 * 分片向量 / 问题向量 / 词法 / Wiki 等召回不能简单 append：各自分值不可比。
 * 用 RRF（Reciprocal Rank Fusion）只依赖排名，天然跨召回源可比，
 * 并且对某一路失效有天然容错——那一路不贡献排名即可（§141）。
 */

export type RecallSource =
    | "chunk_vector"
    | "question_vector"
    | "chunk_bm25"
    | "question_bm25"
    | "wiki"
    // 以下三类只用于尚未重建到新版文章索引的存量兼容。
    | "tree"
    | "vector"
    | "bm25"

export type RecallHit = {
    nodeKey: string
    source: RecallSource
    /** 1-based 排名 */
    rank: number
    score?: number
}

export type FusedCandidate = {
    nodeKey: string
    fusedScore: number
    /** 命中该候选的召回源 */
    recallSources: RecallSource[]
    /** 各召回源上的排名，用于检索诊断 */
    ranks: Partial<Record<RecallSource, number>>
    scores: Partial<Record<RecallSource, number>>
}

export type FusionOptions = {
    /** RRF 平滑常数，越大越弱化头部排名优势 */
    k?: number
    /** 各召回源权重，缺省等权 */
    weights?: Partial<Record<RecallSource, number>>
    topK?: number
}

export function reciprocalRankFusion(
    hitGroups: RecallHit[][],
    options: FusionOptions = {},
): FusedCandidate[] {
    const k = options.k ?? 60
    const weights = options.weights ?? {}
    const byKey = new Map<string, FusedCandidate>()

    for (const hits of hitGroups) {
        for (const hit of hits) {
            const weight = weights[hit.source] ?? 1
            const contribution = weight / (k + hit.rank)
            const existing = byKey.get(hit.nodeKey)
            if (existing) {
                existing.fusedScore += contribution
                if (!existing.recallSources.includes(hit.source)) existing.recallSources.push(hit.source)
                // 同源多次命中保留最靠前的排名
                const prevRank = existing.ranks[hit.source]
                if (prevRank == null || hit.rank < prevRank) existing.ranks[hit.source] = hit.rank
                if (hit.score != null) existing.scores[hit.source] = hit.score
                continue
            }
            byKey.set(hit.nodeKey, {
                nodeKey: hit.nodeKey,
                fusedScore: contribution,
                recallSources: [hit.source],
                ranks: { [hit.source]: hit.rank },
                scores: hit.score == null ? {} : { [hit.source]: hit.score },
            })
        }
    }

    const fused = [...byKey.values()].sort((a, b) => {
        if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore
        // 分数相同时，被更多召回源命中的排前面
        return b.recallSources.length - a.recallSources.length
    })
    for (const item of fused) item.fusedScore = Number(item.fusedScore.toFixed(6))
    return options.topK ? fused.slice(0, options.topK) : fused
}

/** 把有序数组转成带排名的召回命中 */
export function toRecallHits(
    source: RecallSource,
    items: Array<{ nodeKey: string; score?: number }>,
): RecallHit[] {
    return items.map((item, index) => ({
        nodeKey: item.nodeKey,
        source,
        rank: index + 1,
        ...(item.score == null ? {} : { score: item.score }),
    }))
}
