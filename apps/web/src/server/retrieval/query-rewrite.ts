/**
 * 查询改写（§33/§34/§95）。
 *
 * 只对复杂问题生成子查询；简单问题原样返回，不额外增加检索成本。
 * 第一版走规则拆分：不引入额外 LLM 调用，避免简单请求变慢（§135）。
 */

export type RewrittenQuery = {
    original: string
    /** 子查询：拆出的独立检索意图 */
    subQueries: string[]
    /** 关键词查询：去掉疑问词后的名词短语，利于 BM25 */
    keywordQueries: string[]
    applied: boolean
}

const CONJUNCTIONS = /(?:，以及|，还有|，并且|，同时|以及|、并|；|;|，再|，然后|\band\b)/g
// RegExp /g 的 test() 会保留 lastIndex，连续请求时会出现同一句一会儿改写、一会儿不改写。
const HAS_CONJUNCTION = /(?:，以及|，还有|，并且|，同时|以及|、并|；|;|，再|，然后|\band\b)/
const QUESTION_SPLIT = /[，,；;。？?！!]\s*/
const STOP_PREFIX = /^(请问|想知道|帮我|麻烦|我想|能否|可以|请|那么|另外|以及|还有)/
const QUESTION_WORDS = /(是什么|为什么|怎么样|怎么办|如何|怎样|哪些|哪个|多少|吗|呢|？|\?)/g

/** 判断是否值得改写：短问题、单一意图不改写 */
export function shouldRewrite(query: string): boolean {
    const text = query.trim()
    if (text.length < 18) return false
    const clauses = text.split(QUESTION_SPLIT).filter((part) => part.trim().length >= 4)
    return clauses.length >= 2 || HAS_CONJUNCTION.test(text)
}

export function rewriteQuery(query: string, options?: { maxSubQueries?: number }): RewrittenQuery {
    const original = query.trim()
    const max = options?.maxSubQueries ?? 3

    if (!shouldRewrite(original)) {
        return { original, subQueries: [], keywordQueries: [toKeywordQuery(original)].filter(Boolean), applied: false }
    }

    const clauses = original
        .replace(CONJUNCTIONS, "|")
        .split(/[|，,；;。？?！!]\s*/)
        .map((part) => part.replace(STOP_PREFIX, "").trim())
        .filter((part) => part.length >= 4)

    const subQueries = dedupe(clauses).filter((clause) => clause !== original).slice(0, max)
    const keywordQueries = dedupe([original, ...subQueries].map(toKeywordQuery)).filter(Boolean).slice(0, max + 1)

    return {
        original,
        subQueries,
        keywordQueries,
        applied: subQueries.length > 0,
    }
}

/** 去掉疑问词与语气词，留下可直接匹配标题的关键词串 */
export function toKeywordQuery(query: string): string {
    return query
        .replace(QUESTION_WORDS, " ")
        .replace(STOP_PREFIX, "")
        .replace(/\s+/g, " ")
        .trim()
}

function dedupe(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
