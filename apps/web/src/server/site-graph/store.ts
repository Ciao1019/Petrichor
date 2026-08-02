import { and, desc, eq, inArray } from "drizzle-orm"

import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticles,
    knowledgeBases,
    siteGraphEdges,
    siteGraphMergeCandidates,
    siteGraphNodes,
    siteGraphRuns,
    type SiteGraphEdgeRecord,
    type SiteGraphMergeCandidateRecord,
    type SiteGraphNodeRecord,
    type SiteGraphRunRecord,
} from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { loadPublicSiteArticles } from "@/server/public-site/articles"

import { isAlignableKind, type EntityMergeCandidate, type EntityRegistryEntry } from "./entity-registry"
import { assignTopSections, dropEmptySections, keepArticleReachableNodes } from "./payload"
import {
    clampWeight,
    normalizeAliases,
    normalizeAttributes,
    parseJsonOrNull,
} from "./normalize"
import type {
    SiteGraphAdminEdge,
    SiteGraphAdminNode,
    SiteGraphArticleInput,
    SiteGraphAttribute,
    SiteGraphDraft,
    SiteGraphDraftEdge,
    SiteGraphDraftNode,
    SiteGraphEdgeKind,
    SiteGraphNodeKind,
    SiteGraphPayload,
    SiteGraphPayloadLink,
    SiteGraphPayloadNode,
    SiteGraphRunMode,
    SiteGraphRunSummary,
    SiteGraphSource,
    SiteGraphStatus,
    SiteGraphValidationReport,
} from "./types"

type Db = ReturnType<typeof getDb>

function formatDate(value: Date | string | null | undefined) {
    if (!value) return null
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function parseAttributes(raw: string | null | undefined): SiteGraphAttribute[] {
    return normalizeAttributes(parseJsonOrNull(raw))
}

function parseAliases(raw: string | null | undefined): string[] {
    return normalizeAliases(parseJsonOrNull(raw))
}

/**
 * 抽取 Agent 的输入源：完全复用前台公开文章列表的可见性判定
 * （loadPublicSiteArticles 已排除撤销 / 过期 / 加密 / 不可索引的分享），
 * 避免在这里重写一套规则导致私有内容泄漏。
 */
export async function loadPublicArticleInputs(): Promise<SiteGraphArticleInput[]> {
    const publicArticles = await loadPublicSiteArticles()
    if (publicArticles.length === 0) return []

    const articleIds = publicArticles
        .map((article) => Number(article.articleId))
        .filter((id) => Number.isInteger(id) && id > 0)
    if (articleIds.length === 0) return []

    const rows = await getDb()
        .select({
            id: knowledgeBaseArticles.id,
            contentMd: knowledgeBaseArticles.contentMd,
            knowledgeBaseName: knowledgeBases.name,
        })
        .from(knowledgeBaseArticles)
        .innerJoin(knowledgeBases, eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBases.id))
        .where(inArray(knowledgeBaseArticles.id, articleIds))

    const detailById = new Map(rows.map((row) => [String(row.id), row]))

    return publicArticles.flatMap((article) => {
        const detail = detailById.get(article.articleId)
        if (!detail) return []
        return [{
            articleId: article.articleId,
            title: article.title,
            route: article.href,
            excerpt: article.excerpt,
            tags: article.tags,
            contentMd: detail.contentMd,
            updatedAt: article.updatedAt,
            knowledgeBaseName: detail.knowledgeBaseName,
        }]
    })
}

/** 当前允许出现在前台的文章 ID 集合，供校验器拦截私有文章 */
export async function loadPublicArticleIdSet(): Promise<Set<string>> {
    const articles = await loadPublicSiteArticles()
    return new Set(articles.map((article) => article.articleId))
}

interface PersistDraftResult {
    nodeCount: number
    edgeCount: number
    /** 因人工锁定而跳过覆盖的节点/关系数 */
    lockedSkipped: number
    prunedNodes: number
    prunedEdges: number
}

/**
 * 把草稿写入邻接表 + 关系表。
 *
 * 规则：
 * - 已存在且 locked 的节点/关系不被覆盖（后台人工维护结果优先）
 * - 已存在节点保留原有 status，因此重跑不会把已发布内容打回草稿
 * - 新节点一律 DRAFT，需在后台点「发布」才会进入前台
 * - source=MANUAL 或 locked 的旧数据不会被清理，其余不在本次草稿中的 Agent 数据会被删除
 */
export async function persistDraft(input: {
    userId: number
    draft: SiteGraphDraft
}): Promise<PersistDraftResult> {
    const db = getDb()
    const now = new Date()
    const { userId, draft } = input

    const existingNodes = await db
        .select()
        .from(siteGraphNodes)
        .where(eq(siteGraphNodes.userId, userId))
    const existingByKey = new Map(existingNodes.map((node) => [node.nodeKey, node]))

    let lockedSkipped = 0
    const idByKey = new Map<string, number>()

    // 第一轮：写入节点本身，parent 先留空，等所有节点都拿到 ID 后再回填
    for (const [index, node] of draft.nodes.entries()) {
        const existing = existingByKey.get(node.nodeKey)
        if (existing?.locked) {
            lockedSkipped += 1
            idByKey.set(node.nodeKey, existing.id)
            continue
        }

        const values = {
            userId,
            nodeKey: node.nodeKey,
            kind: node.kind,
            name: node.name,
            summary: node.summary || null,
            route: node.route,
            articleId: node.articleId == null ? null : Number(node.articleId),
            attributesJson: JSON.stringify(node.attributes),
            aliasesJson: JSON.stringify(node.aliases),
            weight: node.weight,
            sortOrder: index,
            source: node.source,
            confidence: node.confidence,
            updatedAt: now,
        }

        if (existing) {
            await db
                .update(siteGraphNodes)
                // 曾因文章下架被归档的节点，文章重新公开后要放回草稿，否则永远发布不出去
                .set(existing.status === "ARCHIVED" ? { ...values, status: "DRAFT" } : values)
                .where(eq(siteGraphNodes.id, existing.id))
            idByKey.set(node.nodeKey, existing.id)
            continue
        }

        const [created] = await db
            .insert(siteGraphNodes)
            .values({ ...values, status: "DRAFT", locked: false })
            .returning()
        idByKey.set(node.nodeKey, created.id)
    }

    // 第二轮：回填邻接表的 parent_id
    for (const node of draft.nodes) {
        const id = idByKey.get(node.nodeKey)
        if (id == null) continue
        if (existingByKey.get(node.nodeKey)?.locked) continue
        const parentId = node.parentKey == null ? null : idByKey.get(node.parentKey) ?? null
        await db
            .update(siteGraphNodes)
            .set({ parentId, updatedAt: now })
            .where(eq(siteGraphNodes.id, id))
    }

    // 清理本次草稿中不再出现的 Agent/系统节点（人工节点与锁定节点保留）
    const draftKeys = new Set(draft.nodes.map((node) => node.nodeKey))
    const prunableNodes = existingNodes.filter((node) =>
        node.source !== "MANUAL" && !node.locked && !draftKeys.has(node.nodeKey))
    if (prunableNodes.length > 0) {
        await db
            .delete(siteGraphNodes)
            .where(inArray(siteGraphNodes.id, prunableNodes.map((node) => node.id)))
    }

    const existingEdges = await db
        .select()
        .from(siteGraphEdges)
        .where(eq(siteGraphEdges.userId, userId))
    const edgeKey = (fromId: number, toId: number, relation: string) => `${fromId}|${toId}|${relation}`
    const existingEdgeMap = new Map(existingEdges.map((edge) =>
        [edgeKey(edge.fromNodeId, edge.toNodeId, edge.relation), edge]))

    const keptEdgeIds = new Set<number>()
    for (const edge of draft.edges) {
        const fromId = idByKey.get(edge.fromKey)
        const toId = idByKey.get(edge.toKey)
        if (fromId == null || toId == null || fromId === toId) continue

        const existing = existingEdgeMap.get(edgeKey(fromId, toId, edge.relation))
        if (existing?.locked) {
            lockedSkipped += 1
            keptEdgeIds.add(existing.id)
            continue
        }

        const values = {
            userId,
            fromNodeId: fromId,
            toNodeId: toId,
            relation: edge.relation,
            kind: edge.kind,
            attributesJson: JSON.stringify(edge.attributes),
            weight: edge.weight,
            directed: edge.directed,
            source: edge.source,
            confidence: edge.confidence,
            updatedAt: now,
        }

        if (existing) {
            await db.update(siteGraphEdges).set(values).where(eq(siteGraphEdges.id, existing.id))
            keptEdgeIds.add(existing.id)
            continue
        }

        const [created] = await db
            .insert(siteGraphEdges)
            .values({ ...values, status: "DRAFT", locked: false })
            .returning()
        keptEdgeIds.add(created.id)
    }

    const prunableEdges = existingEdges.filter((edge) =>
        edge.source !== "MANUAL" && !edge.locked && !keptEdgeIds.has(edge.id))
    if (prunableEdges.length > 0) {
        await db
            .delete(siteGraphEdges)
            .where(inArray(siteGraphEdges.id, prunableEdges.map((edge) => edge.id)))
    }

    const [nodeRows, edgeRows] = await Promise.all([
        db.select({ id: siteGraphNodes.id }).from(siteGraphNodes).where(eq(siteGraphNodes.userId, userId)),
        db.select({ id: siteGraphEdges.id }).from(siteGraphEdges).where(eq(siteGraphEdges.userId, userId)),
    ])

    return {
        nodeCount: nodeRows.length,
        edgeCount: edgeRows.length,
        lockedSkipped,
        prunedNodes: prunableNodes.length,
        prunedEdges: prunableEdges.length,
    }
}

/**
 * 把库里的图还原成草稿形态，供「重新校验」复用同一套校验逻辑。
 * 默认排除 ARCHIVED：那些节点既不在前台也不会被发布，再报一遍问题只是噪声。
 */
export async function loadStoredDraft(
    userId: number,
    options: { includeArchived?: boolean } = {},
): Promise<SiteGraphDraft> {
    const db = getDb()
    const liveStatuses: SiteGraphStatus[] = options.includeArchived
        ? ["DRAFT", "PUBLISHED", "ARCHIVED"]
        : ["DRAFT", "PUBLISHED"]
    const [nodes, edges] = await Promise.all([
        db.select().from(siteGraphNodes).where(and(
            eq(siteGraphNodes.userId, userId),
            inArray(siteGraphNodes.status, liveStatuses),
        )),
        db.select().from(siteGraphEdges).where(eq(siteGraphEdges.userId, userId)),
    ])
    const keyById = new Map(nodes.map((node) => [node.id, node.nodeKey]))

    const draftNodes: SiteGraphDraftNode[] = nodes.map((node) => ({
        nodeKey: node.nodeKey,
        parentKey: node.parentId == null ? null : keyById.get(node.parentId) ?? null,
        kind: node.kind as SiteGraphNodeKind,
        name: node.name,
        summary: node.summary ?? "",
        route: node.route,
        articleId: node.articleId == null ? null : String(node.articleId),
        attributes: parseAttributes(node.attributesJson),
        aliases: parseAliases(node.aliasesJson),
        weight: node.weight,
        confidence: node.confidence,
        source: node.source as SiteGraphSource,
    }))

    const draftEdges: SiteGraphDraftEdge[] = edges.flatMap((edge) => {
        const fromKey = keyById.get(edge.fromNodeId)
        const toKey = keyById.get(edge.toNodeId)
        if (!fromKey || !toKey) return []
        return [{
            fromKey,
            toKey,
            relation: edge.relation,
            kind: edge.kind as SiteGraphEdgeKind,
            attributes: parseAttributes(edge.attributesJson),
            weight: edge.weight,
            directed: edge.directed,
            confidence: edge.confidence,
            source: edge.source as SiteGraphSource,
        }]
    })

    return { nodes: draftNodes, edges: draftEdges }
}

function toAdminNode(
    node: SiteGraphNodeRecord,
    context: {
        keyById: Map<number, string>
        depthById: Map<number, number>
        childCountById: Map<number, number>
        degreeById: Map<number, number>
    },
): SiteGraphAdminNode {
    return {
        id: String(node.id),
        nodeKey: node.nodeKey,
        parentId: node.parentId == null ? null : String(node.parentId),
        parentKey: node.parentId == null ? null : context.keyById.get(node.parentId) ?? null,
        kind: node.kind as SiteGraphNodeKind,
        name: node.name,
        summary: node.summary ?? "",
        route: node.route,
        articleId: node.articleId == null ? null : String(node.articleId),
        attributes: parseAttributes(node.attributesJson),
        aliases: parseAliases(node.aliasesJson),
        weight: node.weight,
        sortOrder: node.sortOrder,
        status: node.status as SiteGraphStatus,
        source: node.source as SiteGraphSource,
        confidence: node.confidence,
        locked: node.locked,
        depth: context.depthById.get(node.id) ?? 0,
        childCount: context.childCountById.get(node.id) ?? 0,
        degree: context.degreeById.get(node.id) ?? 0,
        updatedAt: formatDate(node.updatedAt) ?? "",
    }
}

function toAdminEdge(edge: SiteGraphEdgeRecord, nodeById: Map<number, SiteGraphNodeRecord>): SiteGraphAdminEdge {
    const from = nodeById.get(edge.fromNodeId)
    const to = nodeById.get(edge.toNodeId)
    return {
        id: String(edge.id),
        fromNodeId: String(edge.fromNodeId),
        fromNodeKey: from?.nodeKey ?? "",
        fromNodeName: from?.name ?? "（已删除）",
        toNodeId: String(edge.toNodeId),
        toNodeKey: to?.nodeKey ?? "",
        toNodeName: to?.name ?? "（已删除）",
        relation: edge.relation,
        kind: edge.kind as SiteGraphEdgeKind,
        attributes: parseAttributes(edge.attributesJson),
        weight: edge.weight,
        directed: edge.directed,
        status: edge.status as SiteGraphStatus,
        source: edge.source as SiteGraphSource,
        confidence: edge.confidence,
        locked: edge.locked,
        updatedAt: formatDate(edge.updatedAt) ?? "",
    }
}

/** 按邻接表逐层计算深度，避免依赖数据库方言 */
function computeDepths(nodes: SiteGraphNodeRecord[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const depthById = new Map<number, number>()

    for (const node of nodes) {
        if (depthById.has(node.id)) continue
        const chain: number[] = []
        const visiting = new Set<number>()
        let current: SiteGraphNodeRecord | undefined = node
        let baseDepth = -1

        while (current) {
            const cached = depthById.get(current.id)
            if (cached != null) {
                baseDepth = cached
                break
            }
            if (visiting.has(current.id)) {
                baseDepth = -1
                break
            }
            visiting.add(current.id)
            chain.push(current.id)
            current = current.parentId == null ? undefined : byId.get(current.parentId)
        }

        let depth = baseDepth + 1
        for (const id of [...chain].reverse()) {
            depthById.set(id, depth)
            depth += 1
        }
    }

    return depthById
}

export async function loadAdminGraph(userId: number) {
    const db = getDb()
    const [nodes, edges] = await Promise.all([
        db
            .select()
            .from(siteGraphNodes)
            .where(eq(siteGraphNodes.userId, userId))
            .orderBy(siteGraphNodes.sortOrder, siteGraphNodes.id),
        db
            .select()
            .from(siteGraphEdges)
            .where(eq(siteGraphEdges.userId, userId))
            .orderBy(desc(siteGraphEdges.updatedAt)),
    ])

    const keyById = new Map(nodes.map((node) => [node.id, node.nodeKey]))
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const depthById = computeDepths(nodes)

    const childCountById = new Map<number, number>()
    for (const node of nodes) {
        if (node.parentId == null) continue
        childCountById.set(node.parentId, (childCountById.get(node.parentId) ?? 0) + 1)
    }

    const degreeById = new Map<number, number>()
    for (const edge of edges) {
        degreeById.set(edge.fromNodeId, (degreeById.get(edge.fromNodeId) ?? 0) + 1)
        degreeById.set(edge.toNodeId, (degreeById.get(edge.toNodeId) ?? 0) + 1)
    }

    return {
        nodes: nodes.map((node) => toAdminNode(node, { keyById, depthById, childCountById, degreeById })),
        edges: edges.map((edge) => toAdminEdge(edge, nodeById)),
    }
}

/**
 * 前台点群载荷：只取 PUBLISHED。
 * 图谱是站点级单例，只有超级管理员能发布，因此这里不按 user_id 过滤；
 * 万一存在多份，按 node_key 去重并保留更新时间较新的一份。
 *
 * 关键：发布状态只代表「当时可公开」，不代表「现在仍可公开」。文章随时可能被
 * 取消分享 / 加密 / 过期，所以每次读取都要拿当前公开文章集重新过滤一遍，
 * 否则已下架文章的标题与摘要会继续留在前台图谱里。
 */
export async function loadPublicGraphPayload(): Promise<SiteGraphPayload> {
    const db = getDb()
    const [nodes, edges, publicArticles] = await Promise.all([
        db
            .select()
            .from(siteGraphNodes)
            .where(eq(siteGraphNodes.status, "PUBLISHED"))
            .orderBy(siteGraphNodes.sortOrder, siteGraphNodes.id),
        db
            .select()
            .from(siteGraphEdges)
            .where(eq(siteGraphEdges.status, "PUBLISHED")),
        loadPublicSiteArticles(),
    ])

    // 以文章列表为唯一事实来源：标题和链接也一并用最新值覆盖，
    // 避免节点里存的是改标题前的旧值或已失效的旧 shareCode
    const liveArticles = new Map(publicArticles.map((article) => [article.articleId, article]))

    const nodeByKey = new Map<string, SiteGraphNodeRecord>()
    for (const node of nodes) {
        if (node.kind === "article") {
            const articleId = node.articleId == null ? null : String(node.articleId)
            if (!articleId || !liveArticles.has(articleId)) continue
        }
        const existing = nodeByKey.get(node.nodeKey)
        if (!existing || existing.updatedAt < node.updatedAt) {
            nodeByKey.set(node.nodeKey, node)
        }
    }

    const keptIds = new Set([...nodeByKey.values()].map((node) => node.id))
    const keyById = new Map([...nodeByKey.values()].map((node) => [node.id, node.nodeKey]))

    const payloadNodes: SiteGraphPayloadNode[] = []
    const links: SiteGraphPayloadLink[] = []

    for (const node of nodeByKey.values()) {
        const parentKey = node.parentId == null ? null : keyById.get(node.parentId) ?? null
        const live = node.articleId == null ? undefined : liveArticles.get(String(node.articleId))
        payloadNodes.push({
            id: node.nodeKey,
            label: live?.title ?? node.name,
            kind: node.kind as SiteGraphNodeKind,
            route: live?.href ?? node.route,
            summary: node.summary ?? "",
            attributes: parseAttributes(node.attributesJson),
            parentId: parentKey,
            topSectionId: null,
            weight: node.weight,
        })
        if (parentKey) {
            links.push({ source: parentKey, target: node.nodeKey, kind: "structure", relation: "包含" })
        }
    }

    for (const edge of edges) {
        if (!keptIds.has(edge.fromNodeId) || !keptIds.has(edge.toNodeId)) continue
        const source = keyById.get(edge.fromNodeId)
        const target = keyById.get(edge.toNodeId)
        if (!source || !target || source === target) continue
        links.push({ source, target, kind: edge.kind as SiteGraphEdgeKind, relation: edge.relation })
    }

    // 文章下架后，失去全部公开依据的概念/实体/标签一并摘掉，随后清掉空分类
    const visibleNodes = dropEmptySections(keepArticleReachableNodes(payloadNodes, links))
    assignTopSections(visibleNodes)

    const visibleIds = new Set(visibleNodes.map((node) => node.id))
    const visibleLinks = links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target))

    const generatedAt = [...nodeByKey.values()]
        .map((node) => node.updatedAt.getTime())
        .reduce((max, value) => Math.max(max, value), 0)

    return {
        nodes: visibleNodes,
        links: visibleLinks,
        stats: {
            nodeCount: visibleNodes.length,
            linkCount: visibleLinks.length,
            articleCount: visibleNodes.filter((node) => node.kind === "article").length,
            conceptCount: visibleNodes.filter((node) => node.kind === "concept" || node.kind === "entity").length,
        },
        generatedAt: generatedAt > 0 ? new Date(generatedAt).toISOString() : null,
    }
}


/**
 * 归档「文章已不再公开」的文章节点。
 * 发布前自动跑一次，让图谱自己收敛，不必人工重跑一遍 Agent 生成才能解锁发布。
 * 用归档而非删除：文章重新公开时，下一次生成会把它放回草稿（见 persistDraft）。
 * 人工锁定只约束 Agent 覆盖，不豁免可见性收敛，所以 locked 节点同样归档。
 */
export async function archiveStaleArticleNodes(userId: number) {
    const db = getDb()
    const publicArticleIds = await loadPublicArticleIdSet()
    const articleNodes = await db
        .select({ id: siteGraphNodes.id, articleId: siteGraphNodes.articleId, status: siteGraphNodes.status })
        .from(siteGraphNodes)
        .where(and(eq(siteGraphNodes.userId, userId), eq(siteGraphNodes.kind, "article")))

    const staleIds = articleNodes
        .filter((node) => node.status !== "ARCHIVED")
        .filter((node) => node.articleId == null || !publicArticleIds.has(String(node.articleId)))
        .map((node) => node.id)

    if (staleIds.length === 0) return { archived: 0 }
    await db
        .update(siteGraphNodes)
        .set({ status: "ARCHIVED", updatedAt: new Date() })
        .where(and(eq(siteGraphNodes.userId, userId), inArray(siteGraphNodes.id, staleIds)))
    return { archived: staleIds.length }
}

/** 发布：把全部草稿节点/关系置为 PUBLISHED */
export async function publishGraph(userId: number) {
    const db = getDb()
    const now = new Date()
    const nodes = await db
        .update(siteGraphNodes)
        .set({ status: "PUBLISHED", updatedAt: now })
        .where(and(eq(siteGraphNodes.userId, userId), eq(siteGraphNodes.status, "DRAFT")))
        .returning({ id: siteGraphNodes.id })
    const edges = await db
        .update(siteGraphEdges)
        .set({ status: "PUBLISHED", updatedAt: now })
        .where(and(eq(siteGraphEdges.userId, userId), eq(siteGraphEdges.status, "DRAFT")))
        .returning({ id: siteGraphEdges.id })

    return { publishedNodes: nodes.length, publishedEdges: edges.length }
}

/** 下线：把已发布内容退回草稿，前台立即不再展示 */
export async function unpublishGraph(userId: number) {
    const db = getDb()
    const now = new Date()
    const nodes = await db
        .update(siteGraphNodes)
        .set({ status: "DRAFT", updatedAt: now })
        .where(and(eq(siteGraphNodes.userId, userId), eq(siteGraphNodes.status, "PUBLISHED")))
        .returning({ id: siteGraphNodes.id })
    const edges = await db
        .update(siteGraphEdges)
        .set({ status: "DRAFT", updatedAt: now })
        .where(and(eq(siteGraphEdges.userId, userId), eq(siteGraphEdges.status, "PUBLISHED")))
        .returning({ id: siteGraphEdges.id })

    return { unpublishedNodes: nodes.length, unpublishedEdges: edges.length }
}

export interface SaveNodeInput {
    userId: number
    id?: number | null
    nodeKey: string
    parentId?: number | null
    kind: SiteGraphNodeKind
    name: string
    summary?: string | null
    route?: string | null
    attributes: SiteGraphAttribute[]
    aliases: string[]
    weight: number
    status: SiteGraphStatus
    confidence: number
    locked: boolean
}

export async function saveNode(input: SaveNodeInput) {
    const db = getDb()
    const now = new Date()

    if (input.parentId != null) {
        await assertNodeOwned(db, input.userId, input.parentId)
        if (input.id != null && (await isDescendantOf(db, input.userId, input.parentId, input.id))) {
            throw badRequest("父节点不能是自己或自己的子孙节点")
        }
    }

    // 节点键有唯一约束，这里先给出可读的错误而不是让数据库抛 23505
    const [conflict] = await db
        .select({ id: siteGraphNodes.id })
        .from(siteGraphNodes)
        .where(and(eq(siteGraphNodes.userId, input.userId), eq(siteGraphNodes.nodeKey, input.nodeKey)))
        .limit(1)
    if (conflict && conflict.id !== input.id) {
        throw badRequest(`节点键「${input.nodeKey}」已被占用，请改用其他节点键`)
    }

    const values = {
        userId: input.userId,
        nodeKey: input.nodeKey,
        parentId: input.parentId ?? null,
        kind: input.kind,
        name: input.name,
        summary: input.summary?.trim() || null,
        route: input.route?.trim() || null,
        attributesJson: JSON.stringify(input.attributes),
        aliasesJson: JSON.stringify(input.aliases),
        weight: input.weight,
        status: input.status,
        confidence: input.confidence,
        locked: input.locked,
        updatedAt: now,
    }

    if (input.id != null) {
        const current = await assertNodeOwned(db, input.userId, input.id)
        const [updated] = await db
            .update(siteGraphNodes)
            .set({ ...values, source: current.source === "AGENT" ? "MANUAL" : current.source })
            .where(eq(siteGraphNodes.id, input.id))
            .returning()
        return updated
    }

    const [created] = await db
        .insert(siteGraphNodes)
        .values({ ...values, source: "MANUAL", sortOrder: 0 })
        .returning()
    return created
}

export async function deleteNode(userId: number, id: number) {
    const db = getDb()
    await assertNodeOwned(db, userId, id)
    // 关系表有级联删除；子节点的 parent_id 由外键置空，避免删父节点连带删掉整棵子树
    await db.delete(siteGraphNodes).where(and(eq(siteGraphNodes.id, id), eq(siteGraphNodes.userId, userId)))
    return { id: String(id) }
}

export interface SaveEdgeInput {
    userId: number
    id?: number | null
    fromNodeId: number
    toNodeId: number
    relation: string
    kind: SiteGraphEdgeKind
    attributes: SiteGraphAttribute[]
    weight: number
    directed: boolean
    status: SiteGraphStatus
    confidence: number
    locked: boolean
}

export async function saveEdge(input: SaveEdgeInput) {
    if (input.fromNodeId === input.toNodeId) {
        throw badRequest("关系的两端不能是同一个节点")
    }
    const db = getDb()
    await assertNodeOwned(db, input.userId, input.fromNodeId)
    await assertNodeOwned(db, input.userId, input.toNodeId)

    // (起点, 终点, 关系名) 三元组唯一，同样提前给出可读错误
    const [conflict] = await db
        .select({ id: siteGraphEdges.id })
        .from(siteGraphEdges)
        .where(and(
            eq(siteGraphEdges.userId, input.userId),
            eq(siteGraphEdges.fromNodeId, input.fromNodeId),
            eq(siteGraphEdges.toNodeId, input.toNodeId),
            eq(siteGraphEdges.relation, input.relation),
        ))
        .limit(1)
    if (conflict && conflict.id !== input.id) {
        throw badRequest("这两个节点之间已存在同名关系")
    }

    const values = {
        userId: input.userId,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        relation: input.relation,
        kind: input.kind,
        attributesJson: JSON.stringify(input.attributes),
        weight: input.weight,
        directed: input.directed,
        status: input.status,
        confidence: input.confidence,
        locked: input.locked,
        updatedAt: new Date(),
    }

    if (input.id != null) {
        const current = await assertEdgeOwned(db, input.userId, input.id)
        const [updated] = await db
            .update(siteGraphEdges)
            .set({ ...values, source: current.source === "AGENT" ? "MANUAL" : current.source })
            .where(eq(siteGraphEdges.id, input.id))
            .returning()
        return updated
    }

    const [created] = await db
        .insert(siteGraphEdges)
        .values({ ...values, source: "MANUAL" })
        .returning()
    return created
}

export async function deleteEdge(userId: number, id: number) {
    const db = getDb()
    await assertEdgeOwned(db, userId, id)
    await db.delete(siteGraphEdges).where(and(eq(siteGraphEdges.id, id), eq(siteGraphEdges.userId, userId)))
    return { id: String(id) }
}

async function assertNodeOwned(db: Db, userId: number, id: number) {
    const [node] = await db
        .select()
        .from(siteGraphNodes)
        .where(and(eq(siteGraphNodes.id, id), eq(siteGraphNodes.userId, userId)))
        .limit(1)
    if (!node) {
        throw notFound("图谱节点不存在")
    }
    return node
}

async function assertEdgeOwned(db: Db, userId: number, id: number) {
    const [edge] = await db
        .select()
        .from(siteGraphEdges)
        .where(and(eq(siteGraphEdges.id, id), eq(siteGraphEdges.userId, userId)))
        .limit(1)
    if (!edge) {
        throw notFound("图谱关系不存在")
    }
    return edge
}

/** 判断 candidateId 是否是 nodeId 自身或其子孙，用于阻止把父节点设成自己的子孙（成环） */
async function isDescendantOf(db: Db, userId: number, candidateId: number, nodeId: number) {
    if (candidateId === nodeId) return true
    const nodes = await db
        .select({ id: siteGraphNodes.id, parentId: siteGraphNodes.parentId })
        .from(siteGraphNodes)
        .where(eq(siteGraphNodes.userId, userId))
    const byId = new Map(nodes.map((node) => [node.id, node]))

    let current = byId.get(candidateId)
    const visited = new Set<number>()
    while (current && !visited.has(current.id)) {
        visited.add(current.id)
        if (current.parentId === nodeId) return true
        current = current.parentId == null ? undefined : byId.get(current.parentId)
    }
    return false
}

// ===== 运行记录 =====

export async function createRun(input: { userId: number; mode: SiteGraphRunMode }) {
    const [run] = await getDb()
        .insert(siteGraphRuns)
        .values({ userId: input.userId, mode: input.mode, status: "RUNNING" })
        .returning()
    return run
}

export async function finishRun(input: {
    runId: number
    userId: number
    status: "COMPLETED" | "FAILED"
    modelName?: string | null
    articleCount?: number
    nodeCount?: number
    edgeCount?: number
    validation?: SiteGraphValidationReport | null
    warnings?: string[]
    errorMessage?: string | null
}) {
    const now = new Date()
    await getDb()
        .update(siteGraphRuns)
        .set({
            status: input.status,
            modelName: input.modelName ?? null,
            articleCount: input.articleCount ?? 0,
            nodeCount: input.nodeCount ?? 0,
            edgeCount: input.edgeCount ?? 0,
            validationJson: input.validation ? JSON.stringify(input.validation) : null,
            warningsJson: JSON.stringify(input.warnings ?? []),
            errorMessage: input.errorMessage ?? null,
            finishedAt: now,
            updatedAt: now,
        })
        .where(and(eq(siteGraphRuns.id, input.runId), eq(siteGraphRuns.userId, input.userId)))
}

function toRunSummary(run: SiteGraphRunRecord): SiteGraphRunSummary {
    const validation = parseJsonOrNull(run.validationJson)
    const warnings = parseJsonOrNull(run.warningsJson)
    return {
        id: String(run.id),
        status: run.status as SiteGraphRunSummary["status"],
        mode: run.mode as SiteGraphRunMode,
        modelName: run.modelName,
        articleCount: run.articleCount,
        nodeCount: run.nodeCount,
        edgeCount: run.edgeCount,
        validation: validation as SiteGraphValidationReport | null,
        warnings: Array.isArray(warnings) ? warnings.map((item) => String(item)) : [],
        errorMessage: run.errorMessage,
        startedAt: formatDate(run.startedAt) ?? "",
        finishedAt: formatDate(run.finishedAt),
    }
}

export async function listRuns(userId: number, limit = 10) {
    const rows = await getDb()
        .select()
        .from(siteGraphRuns)
        .where(eq(siteGraphRuns.userId, userId))
        .orderBy(desc(siteGraphRuns.startedAt), desc(siteGraphRuns.id))
        .limit(limit)
    return rows.map(toRunSummary)
}

/** 把处于 RUNNING 且已超时的历史记录收尾，避免后台一直显示「生成中」 */
export async function failStaleRuns(userId: number, olderThanMs = 30 * 60 * 1000) {
    const threshold = new Date(Date.now() - olderThanMs)
    const stale = await getDb()
        .select({ id: siteGraphRuns.id, startedAt: siteGraphRuns.startedAt })
        .from(siteGraphRuns)
        .where(and(eq(siteGraphRuns.userId, userId), eq(siteGraphRuns.status, "RUNNING")))
    const staleIds = stale.filter((run) => run.startedAt < threshold).map((run) => run.id)
    if (staleIds.length === 0) return
    await getDb()
        .update(siteGraphRuns)
        .set({ status: "FAILED", errorMessage: "生成超时，已自动标记失败", finishedAt: new Date() })
        .where(and(eq(siteGraphRuns.userId, userId), inArray(siteGraphRuns.id, staleIds)))
}

/** 清空整个图谱（保留运行历史） */
export async function clearGraph(userId: number) {
    const db = getDb()
    await db.delete(siteGraphEdges).where(eq(siteGraphEdges.userId, userId))
    await db.delete(siteGraphNodes).where(eq(siteGraphNodes.userId, userId))
    await db.delete(siteGraphMergeCandidates).where(eq(siteGraphMergeCandidates.userId, userId))
    return { cleared: true }
}

// ===== 实体对齐 =====

/** 把库里已有的概念/实体读成注册表条目，让每次重跑都沿用同一套规范键 */
export async function loadEntityRegistryEntries(userId: number): Promise<EntityRegistryEntry[]> {
    const rows = await getDb()
        .select({
            nodeKey: siteGraphNodes.nodeKey,
            name: siteGraphNodes.name,
            kind: siteGraphNodes.kind,
            aliasesJson: siteGraphNodes.aliasesJson,
            weight: siteGraphNodes.weight,
        })
        .from(siteGraphNodes)
        .where(eq(siteGraphNodes.userId, userId))

    return rows
        .filter((row) => isAlignableKind(row.kind as SiteGraphNodeKind))
        .map((row) => ({
            canonicalKey: row.nodeKey,
            name: row.name,
            aliases: parseAliases(row.aliasesJson),
            kind: row.kind as SiteGraphNodeKind,
            weight: row.weight,
        }))
}

/** 写入本次运行发现的合并候选；已存在的对子保持原状态（人工忽略过就不再骚扰） */
export async function saveMergeCandidates(userId: number, candidates: EntityMergeCandidate[]) {
    if (candidates.length === 0) return { inserted: 0 }
    const db = getDb()
    const existing = await db
        .select({ sourceKey: siteGraphMergeCandidates.sourceKey, targetKey: siteGraphMergeCandidates.targetKey })
        .from(siteGraphMergeCandidates)
        .where(eq(siteGraphMergeCandidates.userId, userId))
    const existingPairs = new Set(existing.map((row) => `${row.sourceKey}|${row.targetKey}`))

    let inserted = 0
    for (const candidate of candidates) {
        if (existingPairs.has(`${candidate.sourceKey}|${candidate.targetKey}`)) continue
        existingPairs.add(`${candidate.sourceKey}|${candidate.targetKey}`)
        await db.insert(siteGraphMergeCandidates).values({
            userId,
            sourceKey: candidate.sourceKey,
            targetKey: candidate.targetKey,
            reason: candidate.reason,
            score: candidate.score,
            detail: candidate.detail,
        })
        inserted += 1
    }
    return { inserted }
}

/** 清理已失效的候选：两端节点只要有一个不在了就没有确认价值 */
export async function pruneStaleMergeCandidates(userId: number) {
    const db = getDb()
    const [candidates, nodes] = await Promise.all([
        db.select().from(siteGraphMergeCandidates).where(and(
            eq(siteGraphMergeCandidates.userId, userId),
            eq(siteGraphMergeCandidates.status, "PENDING"),
        )),
        db.select({ nodeKey: siteGraphNodes.nodeKey }).from(siteGraphNodes).where(eq(siteGraphNodes.userId, userId)),
    ])
    const keys = new Set(nodes.map((node) => node.nodeKey))
    const staleIds = candidates
        .filter((candidate) => !keys.has(candidate.sourceKey) || !keys.has(candidate.targetKey))
        .map((candidate) => candidate.id)
    if (staleIds.length === 0) return
    await db.delete(siteGraphMergeCandidates).where(inArray(siteGraphMergeCandidates.id, staleIds))
}

export interface SiteGraphMergeCandidateView {
    id: string
    sourceKey: string
    sourceName: string
    sourceNodeId: string | null
    targetKey: string
    targetName: string
    targetNodeId: string | null
    reason: string
    score: number
    detail: string | null
    status: string
    createdAt: string
}

export async function listMergeCandidates(userId: number, limit = 100): Promise<SiteGraphMergeCandidateView[]> {
    const db = getDb()
    const [rows, nodes] = await Promise.all([
        db
            .select()
            .from(siteGraphMergeCandidates)
            .where(and(
                eq(siteGraphMergeCandidates.userId, userId),
                eq(siteGraphMergeCandidates.status, "PENDING"),
            ))
            .orderBy(desc(siteGraphMergeCandidates.score), desc(siteGraphMergeCandidates.id))
            .limit(limit),
        db
            .select({ id: siteGraphNodes.id, nodeKey: siteGraphNodes.nodeKey, name: siteGraphNodes.name })
            .from(siteGraphNodes)
            .where(eq(siteGraphNodes.userId, userId)),
    ])
    const byKey = new Map(nodes.map((node) => [node.nodeKey, node]))

    return rows.map((row: SiteGraphMergeCandidateRecord) => {
        const source = byKey.get(row.sourceKey)
        const target = byKey.get(row.targetKey)
        return {
            id: String(row.id),
            sourceKey: row.sourceKey,
            sourceName: source?.name ?? "（已删除）",
            sourceNodeId: source ? String(source.id) : null,
            targetKey: row.targetKey,
            targetName: target?.name ?? "（已删除）",
            targetNodeId: target ? String(target.id) : null,
            reason: row.reason,
            score: row.score,
            detail: row.detail,
            status: row.status,
            createdAt: formatDate(row.createdAt) ?? "",
        }
    })
}

export async function ignoreMergeCandidate(userId: number, id: number) {
    const db = getDb()
    const [updated] = await db
        .update(siteGraphMergeCandidates)
        .set({ status: "IGNORED", updatedAt: new Date() })
        .where(and(eq(siteGraphMergeCandidates.id, id), eq(siteGraphMergeCandidates.userId, userId)))
        .returning({ id: siteGraphMergeCandidates.id })
    if (!updated) {
        throw notFound("合并候选不存在")
    }
    return { id: String(updated.id) }
}

export interface MergeNodesResult {
    targetKey: string
    absorbedAliases: number
    movedEdges: number
    droppedEdges: number
    movedChildren: number
    /** 同名属性取值不一致、以目标节点为准而被丢弃的条数 */
    attributeConflicts: number
}

/**
 * 把 source 节点并入 target：别名、属性、权重归并，关系与子节点改挂到 target，最后删除 source。
 *
 * 属性冲突（同名不同值）以 target 为准，冲突条数会回报给调用方，避免静默丢数据。
 */
export async function mergeNodes(input: {
    userId: number
    sourceNodeId: number
    targetNodeId: number
}): Promise<MergeNodesResult> {
    if (input.sourceNodeId === input.targetNodeId) {
        throw badRequest("不能把节点合并到它自己")
    }
    const db = getDb()
    const source = await assertNodeOwned(db, input.userId, input.sourceNodeId)
    const target = await assertNodeOwned(db, input.userId, input.targetNodeId)

    if (await isDescendantOf(db, input.userId, input.targetNodeId, input.sourceNodeId)) {
        throw badRequest("目标节点是来源节点的子孙，合并会破坏层级")
    }

    const sourceAttributes = parseAttributes(source.attributesJson)
    const targetAttributes = parseAttributes(target.attributesJson)
    const targetAttributeNames = new Map(targetAttributes.map((item) => [item.name.toLowerCase(), item.value]))
    let attributeConflicts = 0
    const mergedAttributes = [...targetAttributes]
    for (const attribute of sourceAttributes) {
        const existingValue = targetAttributeNames.get(attribute.name.toLowerCase())
        if (existingValue === undefined) {
            mergedAttributes.push(attribute)
            targetAttributeNames.set(attribute.name.toLowerCase(), attribute.value)
            continue
        }
        if (existingValue !== attribute.value) {
            attributeConflicts += 1
        }
    }

    const mergedAliases = normalizeAliases([
        ...parseAliases(target.aliasesJson),
        ...parseAliases(source.aliasesJson),
        source.name,
    ])

    await db
        .update(siteGraphNodes)
        .set({
            attributesJson: JSON.stringify(normalizeAttributes(mergedAttributes)),
            aliasesJson: JSON.stringify(mergedAliases),
            weight: clampWeight(target.weight + source.weight),
            confidence: Math.max(target.confidence, source.confidence),
            summary: target.summary?.trim() || source.summary,
            route: target.route ?? source.route,
            updatedAt: new Date(),
        })
        .where(eq(siteGraphNodes.id, target.id))

    // 关系改挂：撞到自环或已有同名三元组的直接删掉，避免违反唯一约束
    const edges = await db
        .select()
        .from(siteGraphEdges)
        .where(eq(siteGraphEdges.userId, input.userId))
    const existingTriples = new Set(
        edges
            .filter((edge) => edge.fromNodeId !== source.id && edge.toNodeId !== source.id)
            .map((edge) => `${edge.fromNodeId}|${edge.toNodeId}|${edge.relation}`),
    )

    let movedEdges = 0
    let droppedEdges = 0
    for (const edge of edges) {
        if (edge.fromNodeId !== source.id && edge.toNodeId !== source.id) continue
        const nextFrom = edge.fromNodeId === source.id ? target.id : edge.fromNodeId
        const nextTo = edge.toNodeId === source.id ? target.id : edge.toNodeId
        const triple = `${nextFrom}|${nextTo}|${edge.relation}`

        if (nextFrom === nextTo || existingTriples.has(triple)) {
            await db.delete(siteGraphEdges).where(eq(siteGraphEdges.id, edge.id))
            droppedEdges += 1
            continue
        }
        existingTriples.add(triple)
        await db
            .update(siteGraphEdges)
            .set({ fromNodeId: nextFrom, toNodeId: nextTo, updatedAt: new Date() })
            .where(eq(siteGraphEdges.id, edge.id))
        movedEdges += 1
    }

    const movedChildren = await db
        .update(siteGraphNodes)
        .set({ parentId: target.id, updatedAt: new Date() })
        .where(and(eq(siteGraphNodes.userId, input.userId), eq(siteGraphNodes.parentId, source.id)))
        .returning({ id: siteGraphNodes.id })

    await db.delete(siteGraphNodes).where(eq(siteGraphNodes.id, source.id))

    // 涉及这两个键的候选都已了结
    await db
        .update(siteGraphMergeCandidates)
        .set({ status: "MERGED", updatedAt: new Date() })
        .where(and(
            eq(siteGraphMergeCandidates.userId, input.userId),
            eq(siteGraphMergeCandidates.sourceKey, source.nodeKey),
        ))

    return {
        targetKey: target.nodeKey,
        absorbedAliases: mergedAliases.length,
        movedEdges,
        droppedEdges,
        movedChildren: movedChildren.length,
        attributeConflicts,
    }
}

/** 后台节点下拉框用的精简列表 */
export async function listNodeOptions(userId: number) {
    const rows = await getDb()
        .select({
            id: siteGraphNodes.id,
            nodeKey: siteGraphNodes.nodeKey,
            name: siteGraphNodes.name,
            kind: siteGraphNodes.kind,
        })
        .from(siteGraphNodes)
        .where(eq(siteGraphNodes.userId, userId))
        .orderBy(siteGraphNodes.kind, siteGraphNodes.name)
    return rows.map((row) => ({
        id: String(row.id),
        nodeKey: row.nodeKey,
        name: row.name,
        kind: row.kind as SiteGraphNodeKind,
    }))
}
