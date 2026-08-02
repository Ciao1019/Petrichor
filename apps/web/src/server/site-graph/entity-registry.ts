import type { SiteGraphDraftNode, SiteGraphNodeKind } from "./types"

/**
 * 实体注册表：解决「同一事物在不同文章 / 不同抽取批次里被起了不同名字」的问题。
 *
 * 对齐分两档：
 * - 精确档（自动合并）：规范化后的名称或任一别名命中倒排索引，直接复用已有的规范键
 * - 模糊档（进待确认队列）：仅名称相近 / 互为子串，产出合并候选交给后台人工确认，绝不自动合并
 *
 * 纯内存结构、无副作用，便于单测覆盖各类同义写法。
 */

export interface EntityRegistryEntry {
    canonicalKey: string
    name: string
    aliases: string[]
    kind: SiteGraphNodeKind
    /** 权重越高越像枢纽实体，回喂给模型提示词时优先展示 */
    weight: number
}

export type EntityMatchKind = "key" | "name" | "alias" | "none"

export interface EntityMergeCandidate {
    /** 本次新抽取到的节点键 */
    sourceKey: string
    /** 注册表里已有的规范键 */
    targetKey: string
    reason: "name_similar" | "name_contains"
    /** 0~100，越高越可能是同一实体 */
    score: number
    detail: string
}

export interface EntityResolveResult {
    canonicalKey: string
    match: EntityMatchKind
    candidate: EntityMergeCandidate | null
}

/** 规范化后名称完全一致才自动合并；模糊相似度达到该阈值只产出候选 */
export const ENTITY_CANDIDATE_THRESHOLD = 0.62
/** 互为子串时，较短一方至少要有这么长才值得提候选，避免「AI」命中一切 */
const MIN_CONTAINMENT_LENGTH = 3
const MAX_CANDIDATES = 100

/**
 * 匹配用的名称归一化：NFKC 折叠全角、转小写、去掉所有空白与标点。
 * 于是「Vector Search」「vector-search」以及全角写法三者等价，
 * 「向量 检索」与「向量检索」也等价。
 */
export function normalizeEntityName(raw: string) {
    return raw
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, "")
}

function bigrams(text: string) {
    if (text.length < 2) return text ? [text] : []
    const grams: string[] = []
    for (let index = 0; index < text.length - 1; index += 1) {
        grams.push(text.slice(index, index + 2))
    }
    return grams
}

/** Dice 系数：两个多重集合的重合度，0~1 */
function diceCoefficient(left: string[], right: string[]) {
    if (left.length === 0 || right.length === 0) return 0
    const counts = new Map<string, number>()
    for (const token of left) {
        counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    let hits = 0
    for (const token of right) {
        const remaining = counts.get(token) ?? 0
        if (remaining > 0) {
            hits += 1
            counts.set(token, remaining - 1)
        }
    }
    return (2 * hits) / (left.length + right.length)
}

/** 短串阈值：中文术语普遍落在这个长度内 */
const SHORT_NAME_LENGTH = 6

/**
 * 名称相似度：0~1，纯确定性、中英文通用。
 *
 * 主信号是二元组重合度，但中文短词的二元组天然偏低——「向量检索」与「向量搜索」
 * 只重合 1/3——所以对短串补一个字符级重合度信号，打九折以压制字序颠倒造成的误判。
 */
export function nameSimilarity(left: string, right: string) {
    if (!left || !right) return 0
    if (left === right) return 1

    const bigramScore = diceCoefficient(bigrams(left), bigrams(right))
    if (Math.min(left.length, right.length) > SHORT_NAME_LENGTH) {
        return bigramScore
    }
    const unigramScore = diceCoefficient([...left], [...right]) * 0.9
    return Math.max(bigramScore, unigramScore)
}

export class SiteGraphEntityRegistry {
    private readonly byKey = new Map<string, EntityRegistryEntry>()
    /** 别名倒排：规范化名称 / 别名 → 规范键 */
    private readonly invertedIndex = new Map<string, string>()
    private readonly candidates: EntityMergeCandidate[] = []

    constructor(entries: EntityRegistryEntry[] = []) {
        for (const entry of entries) {
            this.register(entry)
        }
    }

    /** 把一个实体（及其全部别名）写进倒排索引；重复注册会做并集 */
    register(entry: EntityRegistryEntry) {
        const existing = this.byKey.get(entry.canonicalKey)
        const merged: EntityRegistryEntry = existing
            ? {
                ...existing,
                aliases: dedupeAliases([...existing.aliases, ...entry.aliases]),
                weight: Math.max(existing.weight, entry.weight),
            }
            : { ...entry, aliases: dedupeAliases(entry.aliases) }

        this.byKey.set(merged.canonicalKey, merged)
        for (const label of [merged.name, ...merged.aliases]) {
            const normalized = normalizeEntityName(label)
            if (!normalized) continue
            // 先注册者占位，避免后来的同义词把已有规范键顶掉
            if (!this.invertedIndex.has(normalized)) {
                this.invertedIndex.set(normalized, merged.canonicalKey)
            }
        }
    }

    /**
     * 把一个新抽取到的节点对齐到注册表。
     * 返回应当使用的规范键；若只是相近而非确定同一实体，则额外返回一条合并候选。
     */
    resolve(node: SiteGraphDraftNode): EntityResolveResult {
        if (this.byKey.has(node.nodeKey)) {
            return { canonicalKey: node.nodeKey, match: "key", candidate: null }
        }

        const normalizedName = normalizeEntityName(node.name)
        const nameHit = normalizedName ? this.invertedIndex.get(normalizedName) : undefined
        if (nameHit) {
            return { canonicalKey: nameHit, match: "name", candidate: null }
        }

        for (const alias of node.aliases) {
            const normalizedAlias = normalizeEntityName(alias)
            if (!normalizedAlias) continue
            const aliasHit = this.invertedIndex.get(normalizedAlias)
            if (aliasHit) {
                return { canonicalKey: aliasHit, match: "alias", candidate: null }
            }
        }

        const candidate = this.findCandidate(node, normalizedName)
        return { canonicalKey: node.nodeKey, match: "none", candidate }
    }

    /** 模糊比对：只产候选，不改键 */
    private findCandidate(node: SiteGraphDraftNode, normalizedName: string): EntityMergeCandidate | null {
        if (!normalizedName) return null

        let best: EntityMergeCandidate | null = null
        for (const entry of this.byKey.values()) {
            // 只在 Agent 产出的概念/实体之间做模糊比对，结构骨架节点不参与
            if (!isAlignableKind(entry.kind) || !isAlignableKind(node.kind)) continue

            for (const label of [entry.name, ...entry.aliases]) {
                const normalizedLabel = normalizeEntityName(label)
                if (!normalizedLabel || normalizedLabel === normalizedName) continue

                const shorter = normalizedName.length <= normalizedLabel.length ? normalizedName : normalizedLabel
                const longer = shorter === normalizedName ? normalizedLabel : normalizedName
                const contained = shorter.length >= MIN_CONTAINMENT_LENGTH && longer.includes(shorter)
                const score = nameSimilarity(normalizedName, normalizedLabel)

                if (!contained && score < ENTITY_CANDIDATE_THRESHOLD) continue

                const finalScore = Math.round((contained ? Math.max(score, 0.7) : score) * 100)
                if (best && best.score >= finalScore) continue
                best = {
                    sourceKey: node.nodeKey,
                    targetKey: entry.canonicalKey,
                    reason: contained ? "name_contains" : "name_similar",
                    score: finalScore,
                    detail: contained
                        ? `「${node.name}」与「${label}」互为子串`
                        : `「${node.name}」与「${label}」名称相似度 ${finalScore}%`,
                }
            }
        }

        if (!best || this.candidates.length >= MAX_CANDIDATES) return null
        this.candidates.push(best)
        return best
    }

    mergeCandidates(): EntityMergeCandidate[] {
        return [...this.candidates]
    }

    entries(): EntityRegistryEntry[] {
        return [...this.byKey.values()]
    }

    /** 回喂给后续批次提示词的已知实体清单，按权重取前 N 条 */
    topEntries(limit: number): EntityRegistryEntry[] {
        return [...this.byKey.values()]
            .sort((left, right) => right.weight - left.weight || left.name.localeCompare(right.name, "zh-Hans-CN"))
            .slice(0, limit)
    }
}

/** 只有概念/实体才需要跨文章对齐；root/section/article/tag 由结构骨架唯一确定 */
export function isAlignableKind(kind: SiteGraphNodeKind) {
    return kind === "concept" || kind === "entity"
}

function dedupeAliases(aliases: string[]) {
    const seen = new Set<string>()
    const result: string[] = []
    for (const alias of aliases) {
        const trimmed = alias.trim()
        if (!trimmed) continue
        const normalized = normalizeEntityName(trimmed)
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        result.push(trimmed)
    }
    return result
}
