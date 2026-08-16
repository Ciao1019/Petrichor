import { badRequest } from "@/server/http/response"
import { invalidatePublicSiteGraphCache } from "@/server/public-content-cache"

import { runSiteGraphExtraction } from "./extract-agent"
import { loadAncestorPath, loadNeighborhoodNodeIds, loadSubtreeNodeIds } from "./graph-query"
import {
    clearGraph,
    createRun,
    failStaleRuns,
    finishRun,
    ignoreMergeCandidate,
    listMergeCandidates,
    archiveStaleArticleNodes,
    listNodeOptions,
    listRuns,
    loadAdminGraph,
    loadEntityRegistryEntries,
    loadPublicArticleIdSet,
    loadPublicArticleInputs,
    loadStoredDraft,
    mergeNodes,
    persistDraft,
    pruneStaleMergeCandidates,
    publishGraph,
    saveMergeCandidates,
    unpublishGraph,
} from "./store"
import { summarizeValidationReport, validateSiteGraphDraft } from "./validate"
import type {
    SiteGraphAdminNode,
    SiteGraphRunMode,
    SiteGraphValidationReport,
} from "./types"

// 只读入口在 public-graph.ts，这里转出以保持既有 import 路径不变
export { loadPublicSiteGraph } from "./public-graph"

export interface SiteGraphGenerateResult {
    runId: string
    validation: SiteGraphValidationReport
    warnings: string[]
    articleCount: number
    nodeCount: number
    edgeCount: number
    lockedSkipped: number
    /** 精确命中注册表被自动合并的实体数 */
    autoAlignedCount: number
    /** 新产生的待确认合并候选数 */
    mergeCandidateCount: number
    summary: string
}

/**
 * 生成主流程：公开文章 → 抽取 Agent → 校验 → 落库（草稿态）。
 * 校验不通过不会阻断落库（后台需要看到问题数据才能修），但会阻断「发布」。
 */
export async function generateSiteGraph(input: {
    userId: number
    modelRefId?: number | null
    mode?: SiteGraphRunMode
}): Promise<SiteGraphGenerateResult> {
    const mode = input.mode ?? "FULL"
    await failStaleRuns(input.userId)

    const articles = await loadPublicArticleInputs()
    if (articles.length === 0) {
        throw badRequest("当前没有可用于生成图谱的公开文章，请先公开分享至少一篇文章")
    }

    const run = await createRun({ userId: input.userId, mode })
    try {
        // 用库里已有的概念/实体做对齐基准，保证多次重跑沿用同一套规范键
        const existingEntities = await loadEntityRegistryEntries(input.userId)
        const extraction = await runSiteGraphExtraction({
            userId: input.userId,
            articles,
            modelRefId: input.modelRefId ?? null,
            existingEntities,
        })

        const publicArticleIds = new Set(articles.map((article) => article.articleId))
        const validation = validateSiteGraphDraft(extraction.draft, { publicArticleIds })

        // 先出校验报告再落库：即使数据有问题也要能在后台看到并修复
        const persisted = await persistDraft({ userId: input.userId, draft: extraction.draft })

        // 模糊命中的实体不自动合并，落成待确认候选交给后台人工拍板
        const savedCandidates = await saveMergeCandidates(input.userId, extraction.mergeCandidates)
        await pruneStaleMergeCandidates(input.userId)

        await finishRun({
            runId: run.id,
            userId: input.userId,
            status: "COMPLETED",
            modelName: extraction.modelName,
            articleCount: articles.length,
            nodeCount: persisted.nodeCount,
            edgeCount: persisted.edgeCount,
            validation,
            warnings: extraction.warnings,
        })

        invalidatePublicSiteGraphCache()

        return {
            runId: String(run.id),
            validation,
            warnings: extraction.warnings,
            articleCount: articles.length,
            nodeCount: persisted.nodeCount,
            edgeCount: persisted.edgeCount,
            lockedSkipped: persisted.lockedSkipped,
            autoAlignedCount: extraction.autoAlignedCount,
            mergeCandidateCount: savedCandidates.inserted,
            summary: summarizeValidationReport(validation),
        }
    } catch (error: unknown) {
        await finishRun({
            runId: run.id,
            userId: input.userId,
            status: "FAILED",
            articleCount: articles.length,
            errorMessage: error instanceof Error ? error.message : "生成失败",
        })
        throw error
    }
}

/** 对库里现有图谱重跑校验（人工改过之后使用） */
export async function revalidateSiteGraph(userId: number) {
    const [draft, publicArticleIds] = await Promise.all([
        loadStoredDraft(userId),
        loadPublicArticleIdSet(),
    ])
    const validation = validateSiteGraphDraft(draft, { publicArticleIds })
    return { validation, summary: summarizeValidationReport(validation) }
}

export async function loadSiteGraphOverview(userId: number) {
    await failStaleRuns(userId)
    await pruneStaleMergeCandidates(userId)
    const [graph, runs, options, revalidated, mergeCandidates] = await Promise.all([
        loadAdminGraph(userId),
        listRuns(userId),
        listNodeOptions(userId),
        revalidateSiteGraph(userId),
        listMergeCandidates(userId),
    ])

    const publishedNodes = graph.nodes.filter((node) => node.status === "PUBLISHED").length
    const draftNodes = graph.nodes.filter((node) => node.status === "DRAFT").length

    return {
        nodes: graph.nodes,
        edges: graph.edges,
        runs,
        nodeOptions: options,
        validation: revalidated.validation,
        mergeCandidates,
        stats: {
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            publishedNodes,
            draftNodes,
            lockedNodes: graph.nodes.filter((node) => node.locked).length,
            manualNodes: graph.nodes.filter((node) => node.source === "MANUAL").length,
            articleNodes: graph.nodes.filter((node) => node.kind === "article").length,
            conceptNodes: graph.nodes.filter((node) => node.kind === "concept" || node.kind === "entity").length,
        },
    }
}

/**
 * 发布前先自动归档已下架文章的节点，再强制校验；存在 error 级问题时拒绝发布。
 * 「文章已不公开」现在是 warning 而非 error（前台读取路径已无条件过滤），不阻塞发布。
 */
export async function publishSiteGraph(userId: number) {
    const archived = await archiveStaleArticleNodes(userId)
    const { validation } = await revalidateSiteGraph(userId)
    if (!validation.passed) {
        throw badRequest(`${summarizeValidationReport(validation)}，请先在下方修复错误项`)
    }
    const result = await publishGraph(userId)
    invalidatePublicSiteGraphCache()
    return { ...result, archivedStaleNodes: archived.archived, validation }
}

export async function unpublishSiteGraph(userId: number) {
    const result = await unpublishGraph(userId)
    invalidatePublicSiteGraphCache()
    return result
}

/** 人工确认合并：把来源实体并入目标实体，随后失效前台缓存 */
export async function confirmMergeCandidate(input: {
    userId: number
    sourceNodeId: number
    targetNodeId: number
}) {
    const result = await mergeNodes(input)
    await pruneStaleMergeCandidates(input.userId)
    invalidatePublicSiteGraphCache()
    return result
}

export async function dismissMergeCandidate(userId: number, candidateId: number) {
    return await ignoreMergeCandidate(userId, candidateId)
}

export async function clearSiteGraph(userId: number) {
    const result = await clearGraph(userId)
    invalidatePublicSiteGraphCache()
    return result
}

/**
 * 子树查询（递归 CTE）：后台按节点展开层级，前台也可用于「只看这一支」。
 * 返回结果里附带祖先面包屑，便于定位。
 */
export async function loadSiteGraphSubtree(input: {
    userId: number
    nodeId: number
    depth?: number
}) {
    const [subtree, ancestors, graph] = await Promise.all([
        loadSubtreeNodeIds({ userId: input.userId, rootNodeId: input.nodeId, maxDepth: input.depth }),
        loadAncestorPath({ userId: input.userId, nodeId: input.nodeId }),
        loadAdminGraph(input.userId),
    ])

    const depthById = new Map(subtree.map((row) => [String(row.id), row.depth]))
    const nodes: Array<SiteGraphAdminNode & { subtreeDepth: number }> = graph.nodes
        .filter((node) => depthById.has(node.id))
        .map((node) => ({ ...node, subtreeDepth: depthById.get(node.id) ?? 0 }))
        .sort((left, right) => left.subtreeDepth - right.subtreeDepth || left.sortOrder - right.sortOrder)

    const nodeIds = new Set(nodes.map((node) => node.id))
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.fromNodeId) || nodeIds.has(edge.toNodeId))

    return {
        ancestors: ancestors.map((item) => ({ id: String(item.id), nodeKey: item.nodeKey, name: item.name })),
        nodes,
        edges,
    }
}

/** N 跳邻域查询（递归 CTE）：看某个节点周围的关系网 */
export async function loadSiteGraphNeighborhood(input: {
    userId: number
    nodeId: number
    hops?: number
}) {
    const [ids, graph] = await Promise.all([
        loadNeighborhoodNodeIds({ userId: input.userId, startNodeId: input.nodeId, hops: input.hops }),
        loadAdminGraph(input.userId),
    ])
    const idSet = new Set(ids.map((id) => String(id)))
    const nodes = graph.nodes.filter((node) => idSet.has(node.id))
    const edges = graph.edges.filter((edge) => idSet.has(edge.fromNodeId) && idSet.has(edge.toNodeId))
    return { nodes, edges }
}
