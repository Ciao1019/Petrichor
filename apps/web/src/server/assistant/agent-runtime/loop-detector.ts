import { createHash } from "node:crypto"

/**
 * 循环检测（§59）。四类信号：
 * 1. 完全重复：同 tool + 同 args 连续发生；
 * 2. Pattern loop：A→B→A→B→A→B 交替；
 * 3. 无证据进展：连续 N 次 Tool Call 没有新增 Evidence；
 * 4. 重复检索：query 高度相似且结果指纹未变。
 */

export type LoopSignal =
    | { kind: "exact_repeat"; toolId: string; times: number }
    | { kind: "pattern_loop"; pattern: string[]; cycles: number }
    | { kind: "no_evidence_progress"; calls: number }
    | { kind: "duplicate_search"; toolId: string; similarity: number }

export type LoopDetectorOptions = {
    /** 同 tool+args 连续出现多少次判定为死循环 */
    exactRepeatThreshold?: number
    /** A→B 交替重复多少轮判定为 pattern loop */
    patternCycleThreshold?: number
    /** 连续多少次工具调用无新证据判定为无进展 */
    noProgressThreshold?: number
    /** query 相似度阈值（0~1） */
    querySimilarityThreshold?: number
}

type CallRecord = {
    toolId: string
    argsHash: string
    query?: string
    resultHash?: string
    producedEvidence: boolean
}

export class LoopDetector {
    private readonly calls: CallRecord[] = []
    private readonly exactRepeatThreshold: number
    private readonly patternCycleThreshold: number
    private readonly noProgressThreshold: number
    private readonly querySimilarityThreshold: number

    constructor(options: LoopDetectorOptions = {}) {
        this.exactRepeatThreshold = options.exactRepeatThreshold ?? 3
        this.patternCycleThreshold = options.patternCycleThreshold ?? 3
        this.noProgressThreshold = options.noProgressThreshold ?? 4
        this.querySimilarityThreshold = options.querySimilarityThreshold ?? 0.9
    }

    /** 工具执行完成后登记一次调用；返回触发的循环信号（无则 null） */
    record(entry: {
        toolId: string
        input: unknown
        output?: unknown
        producedEvidence: boolean
    }): LoopSignal | null {
        const query = extractQuery(entry.input)
        this.calls.push({
            toolId: entry.toolId,
            argsHash: stableHash(entry.input),
            ...(query ? { query } : {}),
            ...(entry.output === undefined ? {} : { resultHash: stableHash(entry.output) }),
            producedEvidence: entry.producedEvidence,
        })
        return this.detect()
    }

    detect(): LoopSignal | null {
        return (
            this.detectExactRepeat()
            ?? this.detectDuplicateSearch()
            ?? this.detectPatternLoop()
            ?? this.detectNoEvidenceProgress()
        )
    }

    /** 无进展计数：从末尾往前数连续没有产生证据的调用 */
    noProgressStreak(): number {
        let streak = 0
        for (let i = this.calls.length - 1; i >= 0; i -= 1) {
            if (this.calls[i].producedEvidence) break
            streak += 1
        }
        return streak
    }

    private detectExactRepeat(): LoopSignal | null {
        const last = this.calls.at(-1)
        if (!last) return null
        let times = 0
        for (let i = this.calls.length - 1; i >= 0; i -= 1) {
            const item = this.calls[i]
            if (item.toolId !== last.toolId || item.argsHash !== last.argsHash) break
            times += 1
        }
        if (times >= this.exactRepeatThreshold) {
            return { kind: "exact_repeat", toolId: last.toolId, times }
        }
        return null
    }

    /** query 语义近似且返回指纹一致 → 换个说法反复搜同一件事 */
    private detectDuplicateSearch(): LoopSignal | null {
        const last = this.calls.at(-1)
        if (!last?.query || !last.resultHash) return null
        for (let i = this.calls.length - 2; i >= 0; i -= 1) {
            const prev = this.calls[i]
            if (prev.toolId !== last.toolId || !prev.query || prev.resultHash !== last.resultHash) continue
            const similarity = querySimilarity(prev.query, last.query)
            if (similarity >= this.querySimilarityThreshold) {
                return { kind: "duplicate_search", toolId: last.toolId, similarity }
            }
        }
        return null
    }

    private detectPatternLoop(): LoopSignal | null {
        // 检测周期长度 2~3 的重复模式（以 tool+args 为单位）
        for (const period of [2, 3]) {
            const need = period * this.patternCycleThreshold
            if (this.calls.length < need) continue
            const tail = this.calls.slice(-need)
            const base = tail.slice(0, period).map(signatureOf)
            const matched = tail.every((call, index) => signatureOf(call) === base[index % period])
            // 全同的情况归 exact_repeat，避免重复报警
            if (matched && new Set(base).size > 1) {
                return {
                    kind: "pattern_loop",
                    pattern: tail.slice(0, period).map((call) => call.toolId),
                    cycles: this.patternCycleThreshold,
                }
            }
        }
        return null
    }

    private detectNoEvidenceProgress(): LoopSignal | null {
        const streak = this.noProgressStreak()
        if (streak >= this.noProgressThreshold) {
            return { kind: "no_evidence_progress", calls: streak }
        }
        return null
    }
}

function signatureOf(call: CallRecord): string {
    return `${call.toolId}:${call.argsHash}`
}

/** 稳定序列化后哈希：对象 key 排序，保证同义参数得到同一指纹 */
export function stableHash(value: unknown): string {
    return createHash("sha1").update(stableStringify(value)).digest("hex").slice(0, 16)
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

function extractQuery(input: unknown): string | undefined {
    if (!input || typeof input !== "object") return undefined
    const record = input as Record<string, unknown>
    for (const key of ["query", "q", "objective", "goal", "keyword"]) {
        const value = record[key]
        if (typeof value === "string" && value.trim()) return value.trim()
    }
    return undefined
}

/**
 * 查询相似度：字符 bigram Jaccard。
 * 中文没有空格分词，按字符 bigram 比按词更稳。
 */
export function querySimilarity(a: string, b: string): number {
    const left = bigrams(normalizeQuery(a))
    const right = bigrams(normalizeQuery(b))
    if (left.size === 0 && right.size === 0) return 1
    if (left.size === 0 || right.size === 0) return 0
    let intersection = 0
    for (const gram of left) {
        if (right.has(gram)) intersection += 1
    }
    return intersection / (left.size + right.size - intersection)
}

function normalizeQuery(value: string): string {
    return value.toLowerCase().replace(/\s+/g, "").replace(/[，。！？、；：""''（）()[\]{}.,!?;:'"]/g, "")
}

function bigrams(value: string): Set<string> {
    const set = new Set<string>()
    if (value.length === 1) set.add(value)
    for (let i = 0; i + 1 < value.length; i += 1) set.add(value.slice(i, i + 2))
    return set
}
