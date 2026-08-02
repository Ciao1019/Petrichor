/**
 * 全站星图（Site Graph）共享类型。
 *
 * 数据流：公开文章 → 抽取 Agent（extract-agent）→ 草稿（Draft）→ 校验（validate）
 *        → 落库（store，邻接表 + 关系表）→ 递归 CTE 查询（graph-query）→ 前台点群（payload）。
 */

/** 节点类型。root/section/article 是结构骨架，concept/entity/tag 由 Agent 抽取 */
export const SITE_GRAPH_NODE_KINDS = ["root", "section", "article", "concept", "entity", "tag"] as const
export type SiteGraphNodeKind = (typeof SITE_GRAPH_NODE_KINDS)[number]

/** 关系类型。structure 由邻接表 parent_id 派生，不入关系表 */
export const SITE_GRAPH_EDGE_KINDS = ["reference", "semantic", "derived"] as const
export type SiteGraphEdgeKind = (typeof SITE_GRAPH_EDGE_KINDS)[number]

export const SITE_GRAPH_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const
export type SiteGraphStatus = (typeof SITE_GRAPH_STATUSES)[number]

export const SITE_GRAPH_SOURCES = ["AGENT", "MANUAL", "SYSTEM"] as const
export type SiteGraphSource = (typeof SITE_GRAPH_SOURCES)[number]

export type SiteGraphRunMode = "FULL" | "INCREMENTAL"

/** 节点属性：Agent 抽取的键值对，如 {name:"类型", value:"数据库"} */
export interface SiteGraphAttribute {
    name: string
    value: string
}

/** 抽取阶段的节点草稿：只用业务键（nodeKey）互相引用，尚未分配数据库 ID */
export interface SiteGraphDraftNode {
    nodeKey: string
    parentKey: string | null
    kind: SiteGraphNodeKind
    name: string
    summary: string
    route: string | null
    articleId: string | null
    attributes: SiteGraphAttribute[]
    aliases: string[]
    weight: number
    confidence: number
    source: SiteGraphSource
}

/** 抽取阶段的关系草稿 */
export interface SiteGraphDraftEdge {
    fromKey: string
    toKey: string
    relation: string
    kind: SiteGraphEdgeKind
    attributes: SiteGraphAttribute[]
    weight: number
    directed: boolean
    confidence: number
    source: SiteGraphSource
}

export interface SiteGraphDraft {
    nodes: SiteGraphDraftNode[]
    edges: SiteGraphDraftEdge[]
}

/** 抽取 Agent 使用的文章输入 */
export interface SiteGraphArticleInput {
    articleId: string
    title: string
    /** 前台可访问的站内路径，如 /p/xxxx */
    route: string
    excerpt: string
    tags: string[]
    contentMd: string
    updatedAt: string
    knowledgeBaseName: string
}

/** 前台点群渲染载荷中的节点 */
export interface SiteGraphPayloadNode {
    id: string
    label: string
    kind: SiteGraphNodeKind
    route: string | null
    summary: string
    attributes: SiteGraphAttribute[]
    parentId: string | null
    /** 所属顶层分类，用于点群聚簇着色 */
    topSectionId: string | null
    weight: number
}

/** 前台点群渲染载荷中的连线 */
export interface SiteGraphPayloadLink {
    source: string
    target: string
    kind: "structure" | SiteGraphEdgeKind
    relation: string
}

export interface SiteGraphPayloadStats {
    nodeCount: number
    linkCount: number
    articleCount: number
    conceptCount: number
}

export interface SiteGraphPayload {
    nodes: SiteGraphPayloadNode[]
    links: SiteGraphPayloadLink[]
    stats: SiteGraphPayloadStats
    generatedAt: string | null
}

/** 后台维护页用的节点视图（比前台多出状态/来源/置信度等运维字段） */
export interface SiteGraphAdminNode {
    id: string
    nodeKey: string
    parentId: string | null
    parentKey: string | null
    kind: SiteGraphNodeKind
    name: string
    summary: string
    route: string | null
    articleId: string | null
    attributes: SiteGraphAttribute[]
    aliases: string[]
    weight: number
    sortOrder: number
    status: SiteGraphStatus
    source: SiteGraphSource
    confidence: number
    locked: boolean
    depth: number
    childCount: number
    degree: number
    updatedAt: string
}

export interface SiteGraphAdminEdge {
    id: string
    fromNodeId: string
    fromNodeKey: string
    fromNodeName: string
    toNodeId: string
    toNodeKey: string
    toNodeName: string
    relation: string
    kind: SiteGraphEdgeKind
    attributes: SiteGraphAttribute[]
    weight: number
    directed: boolean
    status: SiteGraphStatus
    source: SiteGraphSource
    confidence: number
    locked: boolean
    updatedAt: string
}

export interface SiteGraphRunSummary {
    id: string
    status: "RUNNING" | "COMPLETED" | "FAILED"
    mode: SiteGraphRunMode
    modelName: string | null
    articleCount: number
    nodeCount: number
    edgeCount: number
    validation: SiteGraphValidationReport | null
    warnings: string[]
    errorMessage: string | null
    startedAt: string
    finishedAt: string | null
}

export type SiteGraphIssueSeverity = "error" | "warning" | "info"

export interface SiteGraphIssue {
    severity: SiteGraphIssueSeverity
    code: string
    /** 出问题的节点/关系业务键，便于后台定位 */
    target: string
    message: string
}

export interface SiteGraphValidationReport {
    score: number
    passed: boolean
    nodeCount: number
    edgeCount: number
    orphanCount: number
    maxDepth: number
    issues: SiteGraphIssue[]
    checkedAt: string
}
