/**
 * 检索用分词与索引词元生成（§27/§91）。
 *
 * 中文不能只按空格切分：这里沿用站内既有的 n-gram 思路，
 * 把中文串展开成 2/3 字滑窗，与英文词一起构成词元集合。
 * 同一套函数同时用于：写入时生成索引列、查询时生成查询词元，
 * 保证两侧口径一致。
 */

const CJK = /[㐀-䶿一-鿿豈-﫿]/
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g
const SPLIT = /[\s\p{P}\p{S}]+/u

export function makeNgrams(text: string, n: number): string[] {
    if (n < 1 || text.length < n) return []
    const grams: string[] = []
    for (let i = 0; i <= text.length - n; i += 1) grams.push(text.slice(i, i + n))
    return grams
}

/**
 * 文档侧词元：英文/数字按词，中文按 2 字滑窗。
 * 只用 bigram 建索引（trigram 由查询侧组合命中），控制索引体积。
 */
export function buildIndexTokens(text: string | null | undefined): string[] {
    const normalized = (text ?? "").toLowerCase().trim()
    if (!normalized) return []
    const tokens: string[] = []

    for (const part of normalized.split(SPLIT)) {
        if (!part) continue
        if (!CJK.test(part)) {
            if (part.length >= 2) tokens.push(part)
            continue
        }
        // 混合串：先抽出中文段做 bigram，再把剩余的字母数字按词保留
        for (const run of part.match(CJK_RUN) ?? []) {
            if (run.length === 1) {
                tokens.push(run)
                continue
            }
            tokens.push(...makeNgrams(run, 2))
        }
        for (const latin of part.split(CJK_RUN)) {
            if (latin && latin.length >= 2) tokens.push(latin)
        }
    }
    return tokens
}

/** 写入索引列用：空格连接的词元串，供 to_tsvector('simple', …) 消费 */
export function buildIndexTokenText(text: string | null | undefined, maxTokens = 4_000): string {
    const tokens = buildIndexTokens(text)
    return (tokens.length > maxTokens ? tokens.slice(0, maxTokens) : tokens).join(" ")
}

/** 查询侧词元：与文档侧同口径，去重后返回 */
export function buildQueryTokens(query: string): string[] {
    return [...new Set(buildIndexTokens(query))]
}

/** Postgres tsquery 串：词元之间用 | 连接（OR 召回，打分交给 BM25） */
export function buildTsQuery(tokens: string[], maxTerms = 48): string {
    return tokens
        .slice(0, maxTerms)
        .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean)
        .map((token) => `${token}:*`.replace(/:\*$/, ""))
        .join(" | ")
}
