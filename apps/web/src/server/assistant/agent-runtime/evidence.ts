import { createHash } from "node:crypto"
import { newId } from "./ids"
import type { AgentEvidence, AgentEvidenceSource } from "./types"

export type EvidenceInput = Omit<AgentEvidence, "id" | "createdAt">

/**
 * 证据存储与去重（§18/§19/§20）。
 *
 * 去重键按优先级取第一个可用：sourceId → nodeKey → canonical URL → 内容哈希 → 归一化标题。
 * 重复命中时不丢弃信息：合并 metadata，并取更高的 relevance/confidence。
 */
export class EvidenceStore {
    private readonly items: AgentEvidence[] = []
    /** 去重键 → evidence id */
    private readonly index = new Map<string, string>()

    add(input: EvidenceInput, now = Date.now()): AgentEvidence {
        const keys = dedupKeys(input)
        for (const key of keys) {
            const existingId = this.index.get(key)
            if (!existingId) continue
            const existing = this.items.find((item) => item.id === existingId)
            if (existing) {
                mergeEvidence(existing, input)
                // 新键也指向同一条，避免下次换个字段又插一条
                for (const k of keys) this.index.set(k, existing.id)
                return existing
            }
        }

        const evidence: AgentEvidence = {
            id: newId("ev"),
            createdAt: now,
            ...input,
            ...(input.freshness == null && input.metadata?.publishedAt
                ? { freshness: freshnessFromDate(input.metadata.publishedAt as string, now) }
                : {}),
            ...(input.metadata?.sourceQuality == null
                ? { metadata: { ...input.metadata, sourceQuality: scoreSourceQuality(input) } }
                : {}),
        }
        this.items.push(evidence)
        for (const key of keys) this.index.set(key, evidence.id)
        return evidence
    }

    addMany(inputs: EvidenceInput[], now = Date.now()): AgentEvidence[] {
        return inputs.map((input) => this.add(input, now))
    }

    /** 合并子代理返回的证据（已带 id，需重新分配以免跨 run 冲突） */
    merge(evidence: AgentEvidence[], now = Date.now()): AgentEvidence[] {
        return evidence.map(({ id: _id, createdAt: _createdAt, ...rest }) => this.add(rest, now))
    }

    get all(): AgentEvidence[] {
        return this.items
    }

    get(id: string): AgentEvidence | null {
        return this.items.find((item) => item.id === id) ?? null
    }

    get size(): number {
        return this.items.length
    }

    /**
     * 一次 Run 内稳定的来源编号（1-based）。
     *
     * 同一篇文章可以产生多条章节 Evidence，但它们属于同一个真实来源，应共享 [n]。
     * 来源的相关性排序可以变化，编号仍只由首次入库顺序决定，不能在 Top-N 时重排。
     */
    citationIndex(id: string): number {
        const itemIndex = this.items.findIndex((item) => item.id === id)
        if (itemIndex < 0) return 0
        return citationIndicesForEvidence(this.items)[itemIndex] ?? 0
    }

    /** 按综合分排序取前 N（§22 evidence budget 的输入） */
    topN(n: number, options?: { source?: AgentEvidenceSource }): AgentEvidence[] {
        const pool = options?.source
            ? this.items.filter((item) => item.source === options.source)
            : this.items
        return [...pool].sort((a, b) => scoreEvidence(b) - scoreEvidence(a)).slice(0, n)
    }
}

/**
 * 给证据按“真实来源”编号：知识库章节按所属文章归并，Wiki 页面按 pageKey 归并，
 * 外部页面按规范化 URL 归并；缺少来源定位时才退回单条证据 id。
 */
export function citationSourceKey(evidence: AgentEvidence): string {
    const metadata = evidence.metadata ?? {}
    const knowledgeBaseId = typeof metadata.knowledgeBaseId === "string"
        ? metadata.knowledgeBaseId.trim()
        : ""
    const scope = knowledgeBaseId ? `${knowledgeBaseId}:` : ""
    const pageKey = typeof metadata.pageKey === "string" ? metadata.pageKey.trim() : ""
    if ((evidence.source === "knowledge" || evidence.source === "wiki") && pageKey) {
        return `wiki:${scope}${pageKey}`
    }

    const articleId = typeof metadata.articleId === "string" ? metadata.articleId.trim() : ""
    if (evidence.source === "knowledge" && articleId) {
        return `knowledge-article:${scope}${articleId}`
    }

    if (evidence.url?.trim()) return `url:${canonicalUrl(evidence.url)}`
    if (evidence.sourceId?.trim()) return `source:${evidence.source}:${evidence.sourceId.trim()}`
    return `evidence:${evidence.id}`
}

export function citationIndicesForEvidence(evidence: AgentEvidence[]): number[] {
    const indices = new Map<string, number>()
    return evidence.map((item) => {
        const key = citationSourceKey(item)
        const existing = indices.get(key)
        if (existing != null) return existing
        const index = indices.size + 1
        indices.set(key, index)
        return index
    })
}

/**
 * 综合排序分：相关性为主，可信度与新鲜度次之，来源质量兜底。
 * 缺失字段给中性默认值，避免没打分的证据被系统性压到最后。
 */
export function scoreEvidence(evidence: AgentEvidence): number {
    const relevance = evidence.relevance ?? 0.5
    const confidence = evidence.confidence ?? 0.5
    const freshness = evidence.freshness ?? 0.5
    const quality = typeof evidence.metadata?.sourceQuality === "number"
        ? evidence.metadata.sourceQuality
        : 0.5
    return relevance * 0.55 + confidence * 0.2 + quality * 0.15 + freshness * 0.1
}

export function dedupKeys(input: EvidenceInput): string[] {
    // 只使用最高优先级的稳定身份。不能同时把正文哈希、标题等弱特征也建成
    // 去重键，否则同一篇文章下两个 nodeKey 不同的章节会因为正文相同而被合并。
    const sourceId = input.sourceId?.trim()
    if (sourceId) return [`sid:${input.source}:${sourceId}`]

    const nodeKey = input.metadata?.nodeKey
    if (typeof nodeKey === "string" && nodeKey.trim()) {
        return [`node:${input.source}:${nodeKey.trim()}`]
    }

    if (input.url?.trim()) return [`url:${canonicalUrl(input.url)}`]

    const content = input.content?.trim()
    if (content) return [`hash:${input.source}:${contentHash(content)}`]

    const title = input.title?.trim()
    if (title) return [`title:${input.source}:${normalizeTitle(title)}`]

    return []
}

/** URL 归一：去协议差异、去 www、去末尾斜杠、去跟踪参数、去 hash */
export function canonicalUrl(raw: string): string {
    try {
        const url = new URL(raw)
        url.hash = ""
        url.protocol = "https:"
        url.hostname = url.hostname.replace(/^www\./, "").toLowerCase()
        const drop: string[] = []
        url.searchParams.forEach((_value, key) => {
            if (/^(utm_|ref$|referrer$|fbclid$|gclid$|spm$|from$)/i.test(key)) drop.push(key)
        })
        for (const key of drop) url.searchParams.delete(key)
        const search = url.searchParams.toString()
        const pathname = url.pathname.replace(/\/+$/, "") || "/"
        return `${url.hostname}${pathname}${search ? `?${search}` : ""}`
    } catch {
        return raw.trim().toLowerCase().replace(/\/+$/, "")
    }
}

export function contentHash(content: string): string {
    // 折叠空白与全角标点，避免同一段文字因排版差异被当成两条证据
    const normalized = content
        .replace(/\s+/g, " ")
        .replace(/[，。；：！？]/g, (ch) => ({ "，": ",", "。": ".", "；": ";", "：": ":", "！": "!", "？": "?" })[ch] ?? ch)
        .trim()
        .toLowerCase()
    return createHash("sha1").update(normalized).digest("hex").slice(0, 20)
}

export function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[-_—–|·:：、,，.。()（）[\]【】"'""'']/g, "")
        .trim()
}

function mergeEvidence(existing: AgentEvidence, incoming: EvidenceInput): void {
    if (!existing.title && incoming.title) existing.title = incoming.title
    if (!existing.url && incoming.url) existing.url = incoming.url
    if (!existing.sourceId && incoming.sourceId) existing.sourceId = incoming.sourceId
    // 内容取更长的一份：通常意味着更完整的片段
    if (incoming.content && incoming.content.length > existing.content.length) {
        existing.content = incoming.content
    }
    // 同一页面被片段读与全文读先后命中时，按全文对待
    if (incoming.fullRead) existing.fullRead = true
    if (incoming.relevance != null) {
        existing.relevance = Math.max(existing.relevance ?? 0, incoming.relevance)
    }
    if (incoming.confidence != null) {
        existing.confidence = Math.max(existing.confidence ?? 0, incoming.confidence)
    }
    if (incoming.freshness != null) {
        existing.freshness = Math.max(existing.freshness ?? 0, incoming.freshness)
    }
    if (incoming.metadata) {
        existing.metadata = { ...existing.metadata, ...incoming.metadata }
    }
}

/**
 * 来源质量规则打分（§41）。第一版规则化即可：
 * 内部知识库 / 图谱视为高可信；官方域名与文档站高于普通博客。
 */
export function scoreSourceQuality(input: EvidenceInput): number {
    if (input.source === "knowledge" || input.source === "graph") return 0.85
    if (input.source === "memory") return 0.7
    if (input.source === "subagent" || input.source === "tool") return 0.6
    if (input.source !== "web") return 0.5

    const host = input.url ? canonicalUrl(input.url).split("/")[0] : ""
    if (!host) return 0.4
    if (/(^|\.)(gov|edu)(\.|$)/.test(host)) return 0.95
    if (/^(docs?|developer|developers|api|learn|support)\./.test(host)) return 0.9
    if (/\b(arxiv|ieee|acm|nature|science)\b/.test(host)) return 0.9
    if (/(^|\.)(github|gitlab)\.(com|io)$/.test(host)) return 0.75
    if (/(medium|zhihu|csdn|jianshu|blogspot|wordpress|substack)\./.test(host)) return 0.45
    return 0.6
}

/** 新鲜度：半衰期 365 天的指数衰减，映射到 0~1 */
export function freshnessFromDate(value: string, now = Date.now()): number | undefined {
    const time = Date.parse(value)
    if (!Number.isFinite(time)) return undefined
    const days = Math.max(0, (now - time) / 86_400_000)
    return Number(Math.pow(0.5, days / 365).toFixed(4))
}
