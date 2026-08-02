import { SITE_GRAPH_LIMITS, SITE_GRAPH_ROOT_KEY } from "./normalize"
import type {
    SiteGraphDraft,
    SiteGraphIssue,
    SiteGraphValidationReport,
} from "./types"

export interface SiteGraphValidateOptions {
    /**
     * 当前允许出现在前台的文章 ID 集合（即公开分享且未过期/未加密的文章）。
     * 传入后会拦截「Agent 把私有文章写进图谱」这类越权泄漏。
     */
    publicArticleIds?: Set<string>
    /** 低于该置信度只记 info，不阻塞发布 */
    minConfidence?: number
}

const DEFAULT_MIN_CONFIDENCE = 50

/**
 * 图谱校验：抽取完成后、写库前必跑一次，后台也可随时重跑。
 * 纯函数，不碰数据库，方便单测覆盖各类畸形数据。
 */
export function validateSiteGraphDraft(
    draft: SiteGraphDraft,
    options: SiteGraphValidateOptions = {},
): SiteGraphValidationReport {
    const issues: SiteGraphIssue[] = []
    const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE

    const nodeByKey = new Map<string, SiteGraphDraft["nodes"][number]>()
    const duplicateKeys = new Set<string>()
    for (const node of draft.nodes) {
        if (nodeByKey.has(node.nodeKey)) {
            duplicateKeys.add(node.nodeKey)
            continue
        }
        nodeByKey.set(node.nodeKey, node)
    }
    for (const key of duplicateKeys) {
        issues.push({
            severity: "error",
            code: "duplicate_key",
            target: key,
            message: "存在重复的节点键，同一节点被定义了多次",
        })
    }

    if (!nodeByKey.has(SITE_GRAPH_ROOT_KEY)) {
        issues.push({
            severity: "error",
            code: "missing_root",
            target: SITE_GRAPH_ROOT_KEY,
            message: "缺少根节点，前台点群无法建立层级",
        })
    }

    if (draft.nodes.length > SITE_GRAPH_LIMITS.maxNodes) {
        issues.push({
            severity: "warning",
            code: "oversized_graph",
            target: "graph",
            message: `节点数 ${draft.nodes.length} 超过上限 ${SITE_GRAPH_LIMITS.maxNodes}，前台渲染可能卡顿`,
        })
    }
    if (draft.edges.length > SITE_GRAPH_LIMITS.maxEdges) {
        issues.push({
            severity: "warning",
            code: "oversized_graph",
            target: "graph",
            message: `关系数 ${draft.edges.length} 超过上限 ${SITE_GRAPH_LIMITS.maxEdges}，前台渲染可能卡顿`,
        })
    }

    const nameOwners = new Map<string, string[]>()
    for (const node of draft.nodes) {
        if (!node.name.trim()) {
            issues.push({
                severity: "error",
                code: "empty_name",
                target: node.nodeKey,
                message: "节点名称为空",
            })
        }
        if (node.route && (!node.route.startsWith("/") || node.route.startsWith("//"))) {
            issues.push({
                severity: "error",
                code: "external_route",
                target: node.nodeKey,
                message: `节点链接 ${node.route} 不是站内路径`,
            })
        }
        if (node.parentKey && !nodeByKey.has(node.parentKey)) {
            issues.push({
                severity: "error",
                code: "broken_parent",
                target: node.nodeKey,
                message: `父节点 ${node.parentKey} 不存在`,
            })
        }
        if (node.kind === "article") {
            if (!node.articleId) {
                issues.push({
                    severity: "error",
                    code: "article_without_id",
                    target: node.nodeKey,
                    message: "文章节点缺少 articleId，无法与站内文章对应",
                })
            } else if (options.publicArticleIds && !options.publicArticleIds.has(node.articleId)) {
                // 只记警告而不是错误：前台载荷（loadPublicGraphPayload）每次读取都会按
                // 当前公开文章集重新过滤，这里已不是唯一防线。判成错误只会在文章下架后
                // 无谓地卡住发布，且与本次要发布的改动毫无关系。
                issues.push({
                    severity: "warning",
                    code: "private_article",
                    target: node.nodeKey,
                    message: `文章 ${node.articleId} 当前未公开，该节点不会出现在前台（发布时会自动归档）`,
                })
            }
        }
        if ((node.kind === "concept" || node.kind === "entity") && node.attributes.length === 0) {
            issues.push({
                severity: "info",
                code: "missing_attributes",
                target: node.nodeKey,
                message: "概念/实体节点没有任何属性，信息量偏低",
            })
        }
        if (!node.summary.trim() && node.kind !== "root") {
            issues.push({
                severity: "info",
                code: "missing_summary",
                target: node.nodeKey,
                message: "节点缺少摘要，前台悬停时无内容可展示",
            })
        }
        if (node.confidence < minConfidence) {
            issues.push({
                severity: "info",
                code: "low_confidence",
                target: node.nodeKey,
                message: `节点置信度 ${node.confidence} 偏低，建议人工确认`,
            })
        }

        const nameKey = node.name.trim().toLowerCase()
        if (nameKey) {
            nameOwners.set(nameKey, [...(nameOwners.get(nameKey) ?? []), node.nodeKey])
        }
    }

    for (const [name, keys] of nameOwners) {
        if (keys.length > 1) {
            issues.push({
                severity: "info",
                code: "duplicate_name",
                target: keys.join(" / "),
                message: `名称「${name}」对应多个节点，可能需要合并`,
            })
        }
    }

    const { cycleKeys, depthByKey } = analyzeParentChains(draft, nodeByKey)
    for (const key of cycleKeys) {
        issues.push({
            severity: "error",
            code: "parent_cycle",
            target: key,
            message: "父子关系成环，层级无法展开",
        })
    }

    let maxDepth = 0
    for (const [key, depth] of depthByKey) {
        maxDepth = Math.max(maxDepth, depth)
        if (depth > SITE_GRAPH_LIMITS.maxDepth) {
            issues.push({
                severity: "warning",
                code: "too_deep",
                target: key,
                message: `节点层级 ${depth} 超过上限 ${SITE_GRAPH_LIMITS.maxDepth}`,
            })
        }
    }

    const connected = new Set<string>()
    for (const edge of draft.edges) {
        const from = nodeByKey.get(edge.fromKey)
        const to = nodeByKey.get(edge.toKey)
        if (!from || !to) {
            issues.push({
                severity: "error",
                code: "broken_edge",
                target: `${edge.fromKey} → ${edge.toKey}`,
                message: "关系端点指向不存在的节点",
            })
            continue
        }
        if (edge.fromKey === edge.toKey) {
            issues.push({
                severity: "error",
                code: "self_edge",
                target: edge.fromKey,
                message: "关系指向自身",
            })
            continue
        }
        if (!edge.relation.trim()) {
            issues.push({
                severity: "error",
                code: "empty_relation",
                target: `${edge.fromKey} → ${edge.toKey}`,
                message: "关系缺少名称",
            })
        }
        if (edge.confidence < minConfidence) {
            issues.push({
                severity: "info",
                code: "low_confidence",
                target: `${edge.fromKey} → ${edge.toKey}`,
                message: `关系置信度 ${edge.confidence} 偏低，建议人工确认`,
            })
        }
        connected.add(edge.fromKey)
        connected.add(edge.toKey)
    }

    const parents = new Set(draft.nodes.map((node) => node.parentKey).filter((key): key is string => Boolean(key)))
    let orphanCount = 0
    for (const node of draft.nodes) {
        if (node.nodeKey === SITE_GRAPH_ROOT_KEY) continue
        const hasParent = Boolean(node.parentKey)
        const hasChild = parents.has(node.nodeKey)
        if (hasParent || hasChild || connected.has(node.nodeKey)) continue
        orphanCount += 1
        if (orphanCount <= 20) {
            issues.push({
                severity: "warning",
                code: "orphan_node",
                target: node.nodeKey,
                message: "孤立节点：既无父节点也无任何关系",
            })
        }
    }

    const errorCount = issues.filter((issue) => issue.severity === "error").length
    const warningCount = issues.filter((issue) => issue.severity === "warning").length
    const score = Math.max(0, 100 - errorCount * 20 - warningCount * 5)

    return {
        score,
        passed: errorCount === 0,
        nodeCount: draft.nodes.length,
        edgeCount: draft.edges.length,
        orphanCount,
        maxDepth,
        issues: issues.slice(0, 200),
        checkedAt: new Date().toISOString(),
    }
}

/** 沿 parentKey 向上走，标记成环节点并计算每个节点的层级深度 */
function analyzeParentChains(
    draft: SiteGraphDraft,
    nodeByKey: Map<string, SiteGraphDraft["nodes"][number]>,
) {
    const cycleKeys = new Set<string>()
    const depthByKey = new Map<string, number>()

    for (const node of draft.nodes) {
        if (depthByKey.has(node.nodeKey)) continue
        const chain: string[] = []
        const visiting = new Set<string>()
        let current: string | null = node.nodeKey
        // 链条顶端之上那一层的深度：走到无父节点时为 -1，于是顶端自身深度为 0
        let baseDepth = -1

        while (current) {
            const cached = depthByKey.get(current)
            if (cached != null) {
                baseDepth = cached
                break
            }
            if (visiting.has(current)) {
                for (const key of chain) cycleKeys.add(key)
                baseDepth = -1
                break
            }
            visiting.add(current)
            chain.push(current)
            const parentKey: string | null = nodeByKey.get(current)?.parentKey ?? null
            current = parentKey && nodeByKey.has(parentKey) ? parentKey : null
        }

        let depth = baseDepth + 1
        for (const key of [...chain].reverse()) {
            if (cycleKeys.has(key)) {
                depthByKey.set(key, 0)
                continue
            }
            depthByKey.set(key, depth)
            depth += 1
        }
    }

    return { cycleKeys, depthByKey }
}

/** 把校验报告压成一句话，用于 toast / 运行记录标题 */
export function summarizeValidationReport(report: SiteGraphValidationReport) {
    const errorCount = report.issues.filter((issue) => issue.severity === "error").length
    const warningCount = report.issues.filter((issue) => issue.severity === "warning").length
    if (errorCount > 0) {
        return `校验未通过：${errorCount} 个错误、${warningCount} 个警告（评分 ${report.score}）`
    }
    if (warningCount > 0) {
        return `校验通过，但有 ${warningCount} 个警告（评分 ${report.score}）`
    }
    return `校验通过（评分 ${report.score}）`
}
