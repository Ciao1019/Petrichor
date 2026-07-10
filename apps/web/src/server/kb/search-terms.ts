/**
 * 站内知识检索用的轻量分词与打分。
 * 中文用户常把整句当查询（无空格），精确 includes 会漏掉「全部歌曲下载进度」→「歌曲下载进度」这类近邻标题。
 */

const CJK_CHAR = /[\u4e00-\u9fff]/
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]+/u

/** 生成长度为 n 的滑动窗口片段（用于中文模糊召回）。 */
export function makeNgrams(text: string, n: number): string[] {
    if (n < 1 || text.length < n) return []
    const grams: string[] = []
    for (let i = 0; i <= text.length - n; i += 1) {
        grams.push(text.slice(i, i + n))
    }
    return grams
}

/**
 * 把查询拆成可打分的词项：
 * - 空格/标点切分的整词保留（英文、已空格分词的中文）
 * - 连续中文且长度 ≥ 3 时，额外展开 2/3 字 n-gram，避免整句精确匹配失败
 */
export function tokenizeSearchQuery(query: string): string[] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []

    const parts = normalized.split(SPACE_OR_PUNCT).filter(Boolean)
    const terms = new Set<string>()

    for (const part of parts) {
        terms.add(part)
        const hasCjk = CJK_CHAR.test(part)
        if (hasCjk && part.length >= 3) {
            for (const n of [2, 3] as const) {
                for (const gram of makeNgrams(part, n)) {
                    terms.add(gram)
                }
            }
        }
    }

    return Array.from(terms)
}

export type SearchScoreFields = {
    title?: string | null
    summary?: string | null
    content?: string | null
    extra?: string | null
}

/**
 * 对标题/摘要/正文加权打分。
 * - 整词命中按词长加权；标题权重最高
 * - 若整词未命中但中文 n-gram 覆盖率 ≥ 阈值，按覆盖率给部分分，保证近邻标题可召回
 */
export function scoreSearchFields(fields: SearchScoreFields, query: string): number {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return 1

    const title = (fields.title ?? "").toLowerCase()
    const summary = (fields.summary ?? "").toLowerCase()
    const content = (fields.content ?? "").toLowerCase()
    const extra = (fields.extra ?? "").toLowerCase()
    const haystack = `${title}\n${summary}\n${content}\n${extra}`

    if (haystack.includes(normalized)) {
        return 100 + normalized.length * 4 + (title.includes(normalized) ? 40 : 0)
    }

    const spaceParts = normalized.split(SPACE_OR_PUNCT).filter(Boolean)
    if (spaceParts.length === 0) return 0

    let score = 0
    for (const part of spaceParts) {
        score += scoreOnePart({ title, summary, content, extra, haystack }, part)
    }
    return score
}

function scoreOnePart(
    fields: { title: string; summary: string; content: string; extra: string; haystack: string },
    part: string,
): number {
    if (!part) return 0

    if (fields.title.includes(part)) return part.length * 6
    if (fields.summary.includes(part) || fields.extra.includes(part)) return part.length * 3
    if (fields.content.includes(part) || fields.haystack.includes(part)) return part.length

    // 中文近邻：用 bigram 覆盖率决定是否给分
    if (!CJK_CHAR.test(part) || part.length < 3) return 0

    const bigrams = makeNgrams(part, 2)
    if (bigrams.length === 0) return 0

    const titleMatched = bigrams.filter((g) => fields.title.includes(g)).length
    const titleRatio = titleMatched / bigrams.length
    if (titleRatio >= 0.5) {
        return Math.round(part.length * 5 * titleRatio)
    }

    const allMatched = bigrams.filter((g) => fields.haystack.includes(g)).length
    const allRatio = allMatched / bigrams.length
    if (allRatio >= 0.6) {
        return Math.round(part.length * 2 * allRatio)
    }

    return 0
}
