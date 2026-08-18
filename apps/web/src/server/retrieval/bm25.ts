import { buildIndexTokens, buildQueryTokens } from "./tokenize"

/**
 * BM25 词法召回（§27）。
 *
 * 实现放在应用层而不是纯 SQL：
 * - Postgres 的 ts_rank 不是 BM25，字段权重与长度归一都对不上；
 * - 但候选集仍由 Postgres GIN 索引先筛（见 knowledge-recall.ts），
 *   这里只对候选池做精确打分，兼顾召回效率与打分正确性。
 * SQLite（测试环境）没有 GIN，退化为全量扫描，逻辑完全一致。
 */

export type Bm25Document = {
    id: string
    title?: string | null
    summary?: string | null
    content?: string | null
}

export type Bm25FieldWeights = { title: number; summary: number; content: number }

export type Bm25Options = {
    k1?: number
    b?: number
    weights?: Bm25FieldWeights
    /** 语料总文档数；缺省用候选池大小（会低估 IDF 区分度） */
    corpusSize?: number
    topK?: number
}

export type Bm25Hit = {
    id: string
    score: number
    /** 命中的查询词元，用于诊断 */
    matchedTerms: string[]
}

const DEFAULT_WEIGHTS: Bm25FieldWeights = { title: 3, summary: 2, content: 1 }

export function bm25Search(
    documents: Bm25Document[],
    query: string,
    options: Bm25Options = {},
): Bm25Hit[] {
    const terms = buildQueryTokens(query)
    if (terms.length === 0 || documents.length === 0) return []

    const k1 = options.k1 ?? 1.5
    const b = options.b ?? 0.75
    const weights = options.weights ?? DEFAULT_WEIGHTS
    const termSet = new Set(terms)

    // 一次遍历同时算出：每篇文档的加权词频、加权长度、每个词的文档频率
    const docStats = documents.map((doc) => {
        const counts = new Map<string, number>()
        let length = 0

        const accumulate = (text: string | null | undefined, weight: number) => {
            if (!text || weight <= 0) return
            for (const token of buildIndexTokens(text)) {
                length += weight
                if (!termSet.has(token)) continue
                counts.set(token, (counts.get(token) ?? 0) + weight)
            }
        }

        accumulate(doc.title, weights.title)
        accumulate(doc.summary, weights.summary)
        accumulate(doc.content, weights.content)

        return { id: doc.id, counts, length }
    })

    const docFreq = new Map<string, number>()
    for (const stat of docStats) {
        for (const term of stat.counts.keys()) {
            docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
        }
    }

    const corpusSize = Math.max(options.corpusSize ?? documents.length, documents.length)
    const avgLength = docStats.reduce((sum, stat) => sum + stat.length, 0) / Math.max(1, docStats.length)

    const hits: Bm25Hit[] = []
    for (const stat of docStats) {
        let score = 0
        const matched: string[] = []
        for (const term of terms) {
            const tf = stat.counts.get(term)
            if (!tf) continue
            matched.push(term)
            const df = docFreq.get(term) ?? 1
            // Robertson-Sparck Jones IDF，加 1 保证非负
            const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5))
            const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (stat.length / Math.max(1, avgLength))))
            score += idf * norm
        }
        if (score > 0) hits.push({ id: stat.id, score: Number(score.toFixed(6)), matchedTerms: matched })
    }

    hits.sort((a, b2) => b2.score - a.score)
    return options.topK ? hits.slice(0, options.topK) : hits
}
