import { createHash } from "node:crypto"

import {
    SITE_GRAPH_EDGE_KINDS,
    SITE_GRAPH_NODE_KINDS,
    type SiteGraphAttribute,
    type SiteGraphDraft,
    type SiteGraphDraftEdge,
    type SiteGraphDraftNode,
    type SiteGraphEdgeKind,
    type SiteGraphNodeKind,
    type SiteGraphSource,
} from "./types"

/** 各类文本/集合上限：既保护数据库，也保证前台点群不会因为节点爆炸而卡死 */
export const SITE_GRAPH_LIMITS = {
    nodeKeyLength: 120,
    nameLength: 60,
    summaryLength: 200,
    relationLength: 20,
    attributeNameLength: 20,
    attributeValueLength: 80,
    attributesPerItem: 8,
    aliasLength: 40,
    aliasesPerNode: 6,
    maxNodes: 1200,
    maxEdges: 2400,
    maxDepth: 6,
} as const

const NODE_KIND_SET = new Set<string>(SITE_GRAPH_NODE_KINDS)
const EDGE_KIND_SET = new Set<string>(SITE_GRAPH_EDGE_KINDS)

/** 业务键归一化：小写、连字符化，保留中文；空串时用哈希兜底保证稳定唯一 */
export function normalizeNodeKey(raw: string) {
    const key = raw
        .trim()
        .toLowerCase()
        .replace(/[\s/\\#?&=]+/g, "-")
        .replace(/[^a-z0-9一-龥._-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, SITE_GRAPH_LIMITS.nodeKeyLength)

    return key || `node-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`
}

export const SITE_GRAPH_ROOT_KEY = "root"

export function buildArticleNodeKey(articleId: string) {
    return `article-${String(articleId).trim()}`
}

export function buildSectionNodeKey(name: string) {
    return normalizeNodeKey(`section-${name}`)
}

export function buildTagNodeKey(tag: string) {
    return normalizeNodeKey(`tag-${tag}`)
}

export function normalizeNodeKind(raw: unknown): SiteGraphNodeKind {
    const value = String(raw ?? "").trim().toLowerCase()
    return NODE_KIND_SET.has(value) ? value as SiteGraphNodeKind : "concept"
}

export function normalizeEdgeKind(raw: unknown): SiteGraphEdgeKind {
    const value = String(raw ?? "").trim().toLowerCase()
    return EDGE_KIND_SET.has(value) ? value as SiteGraphEdgeKind : "reference"
}

export function normalizeSource(raw: unknown): SiteGraphSource {
    const value = String(raw ?? "").trim().toUpperCase()
    return value === "MANUAL" || value === "SYSTEM" ? value : "AGENT"
}

function clampText(raw: unknown, maxLength: number) {
    return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength)
}

export function clampConfidence(raw: unknown) {
    const value = Math.round(Number(raw))
    if (!Number.isFinite(value)) return 80
    return Math.min(100, Math.max(0, value))
}

export function clampWeight(raw: unknown) {
    const value = Math.round(Number(raw))
    if (!Number.isFinite(value)) return 1
    return Math.min(100, Math.max(1, value))
}

/** 属性归一化：去空、去重（按属性名）、截断、限量 */
export function normalizeAttributes(raw: unknown): SiteGraphAttribute[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const attributes: SiteGraphAttribute[] = []
    for (const item of raw) {
        if (!item || typeof item !== "object") continue
        const record = item as Record<string, unknown>
        const name = clampText(record.name ?? record.key, SITE_GRAPH_LIMITS.attributeNameLength)
        const value = clampText(record.value, SITE_GRAPH_LIMITS.attributeValueLength)
        if (!name || !value) continue
        const dedupeKey = name.toLowerCase()
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        attributes.push({ name, value })
        if (attributes.length >= SITE_GRAPH_LIMITS.attributesPerItem) break
    }
    return attributes
}

export function normalizeAliases(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const aliases: string[] = []
    for (const item of raw) {
        const alias = clampText(item, SITE_GRAPH_LIMITS.aliasLength)
        if (!alias) continue
        const dedupeKey = alias.toLowerCase()
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        aliases.push(alias)
        if (aliases.length >= SITE_GRAPH_LIMITS.aliasesPerNode) break
    }
    return aliases
}

/** 只允许站内路径，避免 Agent 编造外链后被前台当作站内跳转 */
export function normalizeRoute(raw: unknown): string | null {
    const value = String(raw ?? "").trim()
    if (!value) return null
    if (!value.startsWith("/") || value.startsWith("//")) return null
    return value.slice(0, 300)
}

export function normalizeDraftNode(raw: unknown): SiteGraphDraftNode | null {
    if (!raw || typeof raw !== "object") return null
    const record = raw as Record<string, unknown>
    const name = clampText(record.name ?? record.label, SITE_GRAPH_LIMITS.nameLength)
    if (!name) return null

    const nodeKey = normalizeNodeKey(String(record.nodeKey ?? record.key ?? name))
    const parentKeyRaw = record.parentKey ?? record.parent
    const parentKey = parentKeyRaw == null || String(parentKeyRaw).trim() === ""
        ? null
        : normalizeNodeKey(String(parentKeyRaw))
    const articleIdRaw = String(record.articleId ?? "").trim()

    return {
        nodeKey,
        parentKey: parentKey === nodeKey ? null : parentKey,
        kind: normalizeNodeKind(record.kind ?? record.type),
        name,
        summary: clampText(record.summary ?? record.description, SITE_GRAPH_LIMITS.summaryLength),
        route: normalizeRoute(record.route ?? record.href),
        articleId: /^\d+$/.test(articleIdRaw) ? articleIdRaw : null,
        attributes: normalizeAttributes(record.attributes),
        aliases: normalizeAliases(record.aliases),
        weight: clampWeight(record.weight ?? 1),
        confidence: clampConfidence(record.confidence ?? 80),
        source: normalizeSource(record.source),
    }
}

export function normalizeDraftEdge(raw: unknown): SiteGraphDraftEdge | null {
    if (!raw || typeof raw !== "object") return null
    const record = raw as Record<string, unknown>
    const fromKey = normalizeNodeKey(String(record.fromKey ?? record.from ?? record.source ?? ""))
    const toKey = normalizeNodeKey(String(record.toKey ?? record.to ?? record.target ?? ""))
    const relation = clampText(record.relation ?? record.label, SITE_GRAPH_LIMITS.relationLength)
    if (!record.fromKey && !record.from && !record.source) return null
    if (!record.toKey && !record.to && !record.target) return null
    if (!relation) return null
    if (fromKey === toKey) return null

    return {
        fromKey,
        toKey,
        relation,
        kind: normalizeEdgeKind(record.kind ?? record.type),
        attributes: normalizeAttributes(record.attributes),
        weight: clampWeight(record.weight ?? 1),
        directed: record.directed === undefined ? true : Boolean(record.directed),
        confidence: clampConfidence(record.confidence ?? 80),
        source: normalizeSource(record.source),
    }
}

function mergeAttributes(left: SiteGraphAttribute[], right: SiteGraphAttribute[]) {
    return normalizeAttributes([...left, ...right])
}

/**
 * 合并同一 nodeKey 的重复节点（多批次抽取时常见）。
 * 保留先出现的结构信息（kind/route/articleId），属性与别名取并集，权重累加、置信度取高。
 */
export function mergeDraftNodes(nodes: SiteGraphDraftNode[]): SiteGraphDraftNode[] {
    const merged = new Map<string, SiteGraphDraftNode>()
    for (const node of nodes) {
        const existing = merged.get(node.nodeKey)
        if (!existing) {
            merged.set(node.nodeKey, { ...node })
            continue
        }
        merged.set(node.nodeKey, {
            ...existing,
            // 结构骨架（root/section/article）优先级高于 Agent 抽取的概念节点
            kind: isStructuralKind(existing.kind) ? existing.kind : node.kind,
            summary: existing.summary || node.summary,
            route: existing.route ?? node.route,
            articleId: existing.articleId ?? node.articleId,
            parentKey: existing.parentKey ?? node.parentKey,
            attributes: mergeAttributes(existing.attributes, node.attributes),
            aliases: normalizeAliases([...existing.aliases, ...node.aliases]),
            weight: clampWeight(existing.weight + node.weight),
            confidence: Math.max(existing.confidence, node.confidence),
            source: existing.source === "MANUAL" || node.source === "MANUAL" ? "MANUAL" : existing.source,
        })
    }
    return [...merged.values()]
}

export function isStructuralKind(kind: SiteGraphNodeKind) {
    return kind === "root" || kind === "section" || kind === "article"
}

/** 合并重复关系（同 from/to/relation），权重累加、置信度取高 */
export function mergeDraftEdges(edges: SiteGraphDraftEdge[]): SiteGraphDraftEdge[] {
    const merged = new Map<string, SiteGraphDraftEdge>()
    for (const edge of edges) {
        const dedupeKey = `${edge.fromKey} ${edge.toKey} ${edge.relation.toLowerCase()}`
        const existing = merged.get(dedupeKey)
        if (!existing) {
            merged.set(dedupeKey, { ...edge })
            continue
        }
        merged.set(dedupeKey, {
            ...existing,
            attributes: mergeAttributes(existing.attributes, edge.attributes),
            weight: clampWeight(existing.weight + edge.weight),
            confidence: Math.max(existing.confidence, edge.confidence),
            directed: existing.directed && edge.directed,
        })
    }
    return [...merged.values()]
}

/**
 * 草稿整体收敛：
 * 1. 合并重复节点/关系
 * 2. 丢弃指向不存在节点的关系（模型幻觉的主要形态）
 * 3. 按上限截断
 */
export function consolidateDraft(draft: SiteGraphDraft): SiteGraphDraft {
    const nodes = mergeDraftNodes(draft.nodes).slice(0, SITE_GRAPH_LIMITS.maxNodes)
    const nodeKeys = new Set(nodes.map((node) => node.nodeKey))

    for (const node of nodes) {
        if (node.parentKey && !nodeKeys.has(node.parentKey)) {
            node.parentKey = null
        }
    }

    const edges = mergeDraftEdges(draft.edges)
        .filter((edge) => nodeKeys.has(edge.fromKey) && nodeKeys.has(edge.toKey))
        .slice(0, SITE_GRAPH_LIMITS.maxEdges)

    return { nodes, edges }
}

/** 从模型返回文本中截出第一个 JSON 对象，兼容 ```json 包裹 */
export function extractJsonObjectText(raw: string) {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start < 0 || end < start) return null
    return text.slice(start, end + 1)
}

export function parseJsonOrNull(raw: string | null | undefined): unknown {
    const text = raw?.trim()
    if (!text) return null
    try {
        return JSON.parse(text) as unknown
    } catch {
        return null
    }
}
