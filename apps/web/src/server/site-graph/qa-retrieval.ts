import { normalizeEntityName } from "./entity-registry"
import type {
    SiteGraphPayload,
    SiteGraphPayloadLink,
    SiteGraphPayloadNode,
} from "./types"

/**
 * 图谱增强检索：把问句落到星图节点上，沿关系边扩散，产出「概念 → … → 公开文章」的链路。
 *
 * 直接消费前台公开载荷（loadPublicSiteGraph）而不是重查数据库，原因有二：
 * 1. 该载荷已经做完全部可见性收敛——只含 PUBLISHED、按当前公开文章集过滤、
 *    并摘掉了失去依据的概念。重查一遍就得把这套规则再实现一次，极易漏。
 * 2. 它带缓存，且图规模上限 1200 节点，内存遍历成本可忽略。
 */

/** 邻域节点：只承担渲染职责，故不带摘要与属性，避免撑大工具返回体 */
export interface GraphRetrievalNode {
    id: string
    label: string
    kind: SiteGraphPayloadNode["kind"]
    /** 距离命中入口的跳数，0 表示自身就是命中节点 */
    hop: number
    /** 站内路径，供卡片里的点群双击跳转；概念类节点为 null */
    route: string | null
}

/** 命中的入口节点：模型需要据此理解「命中了什么」，故保留摘要与属性 */
export interface GraphRetrievalMatch {
    id: string
    label: string
    kind: SiteGraphPayloadNode["kind"]
    summary: string
    route: string | null
    attributes: SiteGraphPayloadNode["attributes"]
    matchedBy?: "name" | "alias" | "attribute" | "summary"
}

export interface GraphRetrievalLink {
    source: string
    target: string
    relation: string
    kind: SiteGraphPayloadLink["kind"]
}

/** 一条可读链路：节点与关系交替，形如 A --阐述--> B --依赖--> C */
export interface GraphRetrievalPath {
    /** 途经节点，含起点与终点 */
    nodes: Array<{ id: string; label: string; kind: SiteGraphPayloadNode["kind"] }>
    /** 长度恒为 nodes.length - 1 */
    relations: string[]
    /** 终点若是文章，给出可直接引用的信息 */
    article?: { articleId: string | null; title: string; href: string | null }
}

export interface GraphRetrievalResult {
    query: string
    matched: GraphRetrievalMatch[]
    nodes: GraphRetrievalNode[]
    links: GraphRetrievalLink[]
    paths: GraphRetrievalPath[]
    /** 链路终点收敛出的公开文章，供后续 read_* 工具继续深挖 */
    articles: Array<{ articleId: string | null; title: string; href: string | null; viaConcepts: string[] }>
    emptyMessage?: string
}

const DEFAULT_MAX_HOPS = 2
const DEFAULT_MATCH_LIMIT = 5
const MAX_PATHS = 12
const MAX_NODES = 60

/** 结构边只表达层级归属，不构成语义线索，扩散时排除 */
function isRelationLink(link: SiteGraphPayloadLink) {
    return link.kind !== "structure"
}

function scoreNode(node: SiteGraphPayloadNode, normalizedQuery: string, rawQuery: string) {
    const label = normalizeEntityName(node.label)
    if (!normalizedQuery) return { score: 0, matchedBy: undefined as GraphRetrievalMatch["matchedBy"] }

    if (label === normalizedQuery) return { score: 100, matchedBy: "name" as const }
    for (const alias of node.aliases ?? []) {
        if (normalizeEntityName(alias) === normalizedQuery) return { score: 95, matchedBy: "alias" as const }
    }
    if (label.includes(normalizedQuery) || normalizedQuery.includes(label)) {
        // 越短的标签被长问句包含时越可能是误命中，按长度比例折减
        const ratio = Math.min(label.length, normalizedQuery.length) / Math.max(label.length, normalizedQuery.length)
        return { score: Math.round(60 * ratio) + 20, matchedBy: "name" as const }
    }
    for (const alias of node.aliases ?? []) {
        const normalizedAlias = normalizeEntityName(alias)
        if (normalizedAlias && (normalizedAlias.includes(normalizedQuery) || normalizedQuery.includes(normalizedAlias))) {
            return { score: 55, matchedBy: "alias" as const }
        }
    }
    for (const attribute of node.attributes) {
        if (normalizeEntityName(attribute.value).includes(normalizedQuery)) {
            return { score: 40, matchedBy: "attribute" as const }
        }
    }
    if (rawQuery && node.summary.includes(rawQuery)) {
        return { score: 30, matchedBy: "summary" as const }
    }
    return { score: 0, matchedBy: undefined }
}

/**
 * 把问句切成候选词再逐个打分：中文问句整体几乎不可能等于某个概念名，
 * 只用整句匹配会导致除「精确提问概念名」外全部落空。
 */
function buildQueryTerms(query: string) {
    const raw = query.trim()
    const segments = raw
        .split(/[\s,，。、；;：:？?！!（）()「」【】/|]+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2)
    return [raw, ...segments]
}

function pickMatchedNodes(payload: SiteGraphPayload, query: string, limit: number) {
    const terms = buildQueryTerms(query)
    const best = new Map<string, { node: SiteGraphPayloadNode; score: number; matchedBy: GraphRetrievalMatch["matchedBy"] }>()

    for (const term of terms) {
        const normalized = normalizeEntityName(term)
        if (!normalized) continue
        for (const node of payload.nodes) {
            // 结构骨架不作为语义入口：root/section 命中没有信息量
            if (node.kind === "root" || node.kind === "section") continue
            const { score, matchedBy } = scoreNode(node, normalized, term)
            if (score <= 0) continue
            const prev = best.get(node.id)
            if (!prev || score > prev.score) best.set(node.id, { node, score, matchedBy })
        }
    }

    return [...best.values()]
        .sort((left, right) => right.score - left.score || right.node.weight - left.node.weight)
        .slice(0, limit)
}

/** 从入口节点做限跳 BFS，同时记录前驱以便还原链路 */
function expandNeighborhood(
    payload: SiteGraphPayload,
    entryIds: string[],
    maxHops: number,
) {
    const nodeById = new Map(payload.nodes.map((node) => [node.id, node]))
    const neighbors = new Map<string, Array<{ id: string; relation: string; kind: SiteGraphPayloadLink["kind"] }>>()
    for (const link of payload.links) {
        if (!isRelationLink(link)) continue
        if (!nodeById.has(link.source) || !nodeById.has(link.target)) continue
        neighbors.set(link.source, [...(neighbors.get(link.source) ?? []), { id: link.target, relation: link.relation, kind: link.kind }])
        neighbors.set(link.target, [...(neighbors.get(link.target) ?? []), { id: link.source, relation: link.relation, kind: link.kind }])
    }

    const hopById = new Map<string, number>()
    const prevById = new Map<string, { from: string; relation: string }>()
    const usedLinks: GraphRetrievalLink[] = []
    const seenLink = new Set<string>()
    const queue: string[] = []

    for (const id of entryIds) {
        if (!nodeById.has(id) || hopById.has(id)) continue
        hopById.set(id, 0)
        queue.push(id)
    }

    while (queue.length > 0) {
        const current = queue.shift()
        if (current == null) continue
        const hop = hopById.get(current) ?? 0
        if (hop >= maxHops) continue
        for (const edge of neighbors.get(current) ?? []) {
            const linkKey = [current, edge.id].sort().join("|") + "|" + edge.relation
            if (!seenLink.has(linkKey)) {
                seenLink.add(linkKey)
                usedLinks.push({ source: current, target: edge.id, relation: edge.relation, kind: edge.kind })
            }
            if (hopById.has(edge.id)) continue
            if (hopById.size >= MAX_NODES) continue
            hopById.set(edge.id, hop + 1)
            prevById.set(edge.id, { from: current, relation: edge.relation })
            queue.push(edge.id)
        }
    }

    return { nodeById, hopById, prevById, usedLinks }
}

/** 沿前驱链回溯出「入口 → 该节点」的完整路径 */
function tracePath(
    targetId: string,
    nodeById: Map<string, SiteGraphPayloadNode>,
    prevById: Map<string, { from: string; relation: string }>,
): GraphRetrievalPath | null {
    const nodes: GraphRetrievalPath["nodes"] = []
    const relations: string[] = []
    const guard = new Set<string>()

    let cursor: string | undefined = targetId
    while (cursor && !guard.has(cursor)) {
        guard.add(cursor)
        const node = nodeById.get(cursor)
        if (!node) return null
        nodes.unshift({ id: node.id, label: node.label, kind: node.kind })
        const prev = prevById.get(cursor)
        if (!prev) break
        relations.unshift(prev.relation)
        cursor = prev.from
    }

    if (nodes.length < 2) return null
    const tail = nodeById.get(targetId)
    return {
        nodes,
        relations,
        article: tail?.kind === "article"
            ? { articleId: extractArticleId(tail.id), title: tail.label, href: tail.route }
            : undefined,
    }
}

/** 文章节点的业务键固定为 article-<id> */
function extractArticleId(nodeId: string) {
    const match = nodeId.match(/^article-(\d+)$/)
    return match ? match[1] : null
}

export function retrieveFromGraph(
    payload: SiteGraphPayload,
    input: { query: string; maxHops?: number; limit?: number },
): GraphRetrievalResult {
    const query = input.query.trim()
    const maxHops = Math.min(Math.max(input.maxHops ?? DEFAULT_MAX_HOPS, 1), 3)
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_MATCH_LIMIT, 1), 10)

    const matches = pickMatchedNodes(payload, query, limit)
    if (matches.length === 0) {
        return {
            query,
            matched: [],
            nodes: [],
            links: [],
            paths: [],
            articles: [],
            emptyMessage: "星图里没有匹配的概念或实体，请改用 search_public_articles 做全文检索",
        }
    }

    const { nodeById, hopById, prevById, usedLinks } = expandNeighborhood(
        payload,
        matches.map((item) => item.node.id),
        maxHops,
    )

    const nodes: GraphRetrievalNode[] = [...hopById.entries()]
        .flatMap(([id, hop]) => {
            const node = nodeById.get(id)
            return node ? [{ id: node.id, label: node.label, kind: node.kind, hop, route: node.route }] : []
        })
        .sort((left, right) => left.hop - right.hop)

    // 入口节点单独构造：摘要截断到一句话，够模型判断命中了什么，又不至于把返回体撑爆
    const matched: GraphRetrievalMatch[] = matches.map((item) => ({
        id: item.node.id,
        label: item.node.label,
        kind: item.node.kind,
        summary: item.node.summary.slice(0, 100),
        route: item.node.route,
        attributes: item.node.attributes,
        matchedBy: item.matchedBy,
    }))

    // 链路优先取通向文章的：那是可引用、可继续深挖的终点
    const articleTargets = nodes.filter((node) => node.kind === "article" && node.hop > 0)
    const conceptTargets = nodes.filter((node) => node.kind !== "article" && node.hop > 0)
    const paths = [...articleTargets, ...conceptTargets]
        .map((node) => tracePath(node.id, nodeById, prevById))
        .filter((path): path is GraphRetrievalPath => path !== null)
        .slice(0, MAX_PATHS)

    const articles = new Map<string, { articleId: string | null; title: string; href: string | null; viaConcepts: string[] }>()

    // 问句直接命中文章标题时，该文章是最相关的一篇，但它位于 hop 0、不会产生链路，
    // 若只从 paths 收集就会把它漏掉。
    for (const node of nodes) {
        if (node.kind !== "article" || node.hop !== 0) continue
        const articleId = extractArticleId(node.id)
        articles.set(articleId ?? node.label, {
            articleId,
            title: node.label,
            href: node.route,
            viaConcepts: [],
        })
    }

    for (const path of paths) {
        if (!path.article) continue
        const key = path.article.articleId ?? path.article.title
        const via = path.nodes.slice(0, -1).map((node) => node.label)
        const existing = articles.get(key)
        if (existing) {
            existing.viaConcepts = [...new Set([...existing.viaConcepts, ...via])]
            continue
        }
        articles.set(key, { ...path.article, viaConcepts: via })
    }

    return {
        query,
        matched,
        nodes,
        links: usedLinks,
        paths,
        articles: [...articles.values()],
    }
}
