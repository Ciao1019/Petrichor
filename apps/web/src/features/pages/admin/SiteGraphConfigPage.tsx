"use client"

import * as React from "react"
import {
    AlertTriangle,
    CheckCircle2,
    Info,
    Loader2,
    Lock,
    LockOpen,
    Merge,
    Network,
    Plus,
    RefreshCw,
    Send,
    Sparkles,
    Trash2,
    Undo2,
    X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
    adminSiteGraphApi,
    type SiteGraphAdminEdge,
    type SiteGraphAdminNode,
    type SiteGraphAttribute,
    type SiteGraphEdgeKind,
    type SiteGraphIssue,
    type SiteGraphMergeCandidate,
    type SiteGraphNodeKind,
    type SiteGraphOverviewResponse,
    type SiteGraphStatus,
} from "@/lib/api"

const NODE_KIND_OPTIONS: { value: SiteGraphNodeKind; label: string }[] = [
    { value: "root", label: "站点根" },
    { value: "section", label: "分类" },
    { value: "article", label: "文章" },
    { value: "concept", label: "概念" },
    { value: "entity", label: "实体" },
    { value: "tag", label: "标签" },
]

const EDGE_KIND_OPTIONS: { value: SiteGraphEdgeKind; label: string }[] = [
    { value: "reference", label: "引用" },
    { value: "semantic", label: "语义关联" },
    { value: "derived", label: "衍生" },
]

const STATUS_OPTIONS: { value: SiteGraphStatus; label: string }[] = [
    { value: "DRAFT", label: "草稿" },
    { value: "PUBLISHED", label: "已发布" },
    { value: "ARCHIVED", label: "已归档" },
]

const KIND_LABEL: Record<SiteGraphNodeKind, string> = {
    root: "站点根",
    section: "分类",
    article: "文章",
    concept: "概念",
    entity: "实体",
    tag: "标签",
}

const SEVERITY_META = {
    error: { label: "错误", icon: AlertTriangle, className: "text-destructive" },
    warning: { label: "警告", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
    info: { label: "提示", icon: Info, className: "text-muted-foreground" },
} as const

interface NodeFormState {
    id: string | null
    nodeKey: string
    parentId: string
    kind: SiteGraphNodeKind
    name: string
    summary: string
    route: string
    attributesText: string
    aliasesText: string
    weight: string
    status: SiteGraphStatus
    confidence: string
    locked: boolean
}

interface EdgeFormState {
    id: string | null
    fromNodeId: string
    toNodeId: string
    relation: string
    kind: SiteGraphEdgeKind
    attributesText: string
    weight: string
    status: SiteGraphStatus
    confidence: string
    directed: boolean
    locked: boolean
}

const NONE_PARENT = "__none__"

function emptyNodeForm(): NodeFormState {
    return {
        id: null,
        nodeKey: "",
        parentId: NONE_PARENT,
        kind: "concept",
        name: "",
        summary: "",
        route: "",
        attributesText: "",
        aliasesText: "",
        weight: "1",
        status: "DRAFT",
        confidence: "100",
        locked: true,
    }
}

function emptyEdgeForm(): EdgeFormState {
    return {
        id: null,
        fromNodeId: "",
        toNodeId: "",
        relation: "",
        kind: "reference",
        attributesText: "",
        weight: "1",
        status: "DRAFT",
        confidence: "100",
        directed: true,
        locked: true,
    }
}

/** 属性在表单里用「名称=值」逐行编辑，比嵌套表格更省事也更好粘贴 */
function attributesToText(attributes: SiteGraphAttribute[]) {
    return attributes.map((attribute) => `${attribute.name}=${attribute.value}`).join("\n")
}

function parseAttributesText(text: string): SiteGraphAttribute[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            const index = line.indexOf("=")
            if (index <= 0) return []
            const name = line.slice(0, index).trim()
            const value = line.slice(index + 1).trim()
            return name && value ? [{ name, value }] : []
        })
}

function parseListText(text: string) {
    return text
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
}

function toNodeForm(node: SiteGraphAdminNode): NodeFormState {
    return {
        id: node.id,
        nodeKey: node.nodeKey,
        parentId: node.parentId ?? NONE_PARENT,
        kind: node.kind,
        name: node.name,
        summary: node.summary,
        route: node.route ?? "",
        attributesText: attributesToText(node.attributes),
        aliasesText: node.aliases.join(", "),
        weight: String(node.weight),
        status: node.status,
        confidence: String(node.confidence),
        locked: node.locked,
    }
}

function toEdgeForm(edge: SiteGraphAdminEdge): EdgeFormState {
    return {
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        relation: edge.relation,
        kind: edge.kind,
        attributesText: attributesToText(edge.attributes),
        weight: String(edge.weight),
        status: edge.status,
        confidence: String(edge.confidence),
        directed: edge.directed,
        locked: edge.locked,
    }
}

function resolveApiError(error: unknown, fallback: string) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        fallback
    )
}

function toPositiveInt(value: string, fallback: number) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

function formatDateTime(value?: string | null) {
    if (!value) return "—"
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function SiteGraphConfigPage() {
    const [overview, setOverview] = React.useState<SiteGraphOverviewResponse | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [generating, setGenerating] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [nodeForm, setNodeForm] = React.useState<NodeFormState>(emptyNodeForm)
    const [edgeForm, setEdgeForm] = React.useState<EdgeFormState>(emptyEdgeForm)
    const [nodeKeyword, setNodeKeyword] = React.useState("")

    const fetchOverview = React.useCallback(async () => {
        setLoading(true)
        try {
            const res = await adminSiteGraphApi.overview()
            setOverview(res.data)
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "加载全站星图失败"))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void fetchOverview()
    }, [fetchOverview])

    const runWithBusy = React.useCallback(async (action: () => Promise<void>) => {
        setBusy(true)
        try {
            await action()
        } finally {
            setBusy(false)
        }
    }, [])

    const handleGenerate = React.useCallback(async () => {
        setGenerating(true)
        try {
            const res = await adminSiteGraphApi.generate({})
            const {
                validation, articleCount, nodeCount, edgeCount, warnings, summary,
                autoAlignedCount, mergeCandidateCount,
            } = res.data
            toast[validation.passed ? "success" : "warning"](
                `已从 ${articleCount} 篇公开文章生成 ${nodeCount} 个节点 / ${edgeCount} 条关系。${summary}`,
            )
            if (autoAlignedCount > 0 || mergeCandidateCount > 0) {
                toast.info(`实体对齐：自动合并 ${autoAlignedCount} 处，新增 ${mergeCandidateCount} 条待确认候选`)
            }
            if (warnings.length > 0) {
                toast.info(`生成提示：${warnings.slice(0, 3).join("；")}`)
            }
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "生成星图失败"))
        } finally {
            setGenerating(false)
        }
    }, [fetchOverview])

    const handleValidate = React.useCallback(() => runWithBusy(async () => {
        try {
            const res = await adminSiteGraphApi.validate()
            toast[res.data.validation.passed ? "success" : "warning"](res.data.summary)
            setOverview((current) => (current ? { ...current, validation: res.data.validation } : current))
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "校验失败"))
        }
    }), [runWithBusy])

    const handlePublish = React.useCallback(() => runWithBusy(async () => {
        try {
            const res = await adminSiteGraphApi.publish()
            toast.success(`已发布 ${res.data.publishedNodes} 个节点、${res.data.publishedEdges} 条关系`)
            if (res.data.archivedStaleNodes > 0) {
                toast.info(`另有 ${res.data.archivedStaleNodes} 个节点因文章已取消公开被自动归档`)
            }
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "发布失败"))
        }
    }), [fetchOverview, runWithBusy])

    const handleUnpublish = React.useCallback(() => runWithBusy(async () => {
        try {
            const res = await adminSiteGraphApi.unpublish()
            toast.success(`已下线 ${res.data.unpublishedNodes} 个节点、${res.data.unpublishedEdges} 条关系`)
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "下线失败"))
        }
    }), [fetchOverview, runWithBusy])

    const handleClear = React.useCallback(() => runWithBusy(async () => {
        if (!window.confirm("确定清空整个全站星图？人工维护的节点与关系也会一并删除，且不可撤销。")) {
            return
        }
        try {
            await adminSiteGraphApi.clear()
            toast.success("全站星图已清空")
            setNodeForm(emptyNodeForm())
            setEdgeForm(emptyEdgeForm())
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "清空失败"))
        }
    }), [fetchOverview, runWithBusy])

    const handleSaveNode = React.useCallback(() => runWithBusy(async () => {
        if (!nodeForm.name.trim()) {
            toast.error("请填写节点名称")
            return
        }
        try {
            await adminSiteGraphApi.saveNode({
                id: nodeForm.id,
                nodeKey: nodeForm.nodeKey.trim() || undefined,
                parentId: nodeForm.parentId === NONE_PARENT ? null : nodeForm.parentId,
                kind: nodeForm.kind,
                name: nodeForm.name.trim(),
                summary: nodeForm.summary.trim(),
                route: nodeForm.route.trim(),
                attributes: parseAttributesText(nodeForm.attributesText),
                aliases: parseListText(nodeForm.aliasesText),
                weight: toPositiveInt(nodeForm.weight, 1),
                status: nodeForm.status,
                confidence: toPositiveInt(nodeForm.confidence, 100),
                locked: nodeForm.locked,
            })
            toast.success(nodeForm.id ? "节点已更新" : "节点已新增")
            setNodeForm(emptyNodeForm())
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "保存节点失败"))
        }
    }), [fetchOverview, nodeForm, runWithBusy])

    const handleDeleteNode = React.useCallback((node: SiteGraphAdminNode) => runWithBusy(async () => {
        if (!window.confirm(`确定删除节点「${node.name}」？其关系会一并删除，子节点将变为无父节点。`)) {
            return
        }
        try {
            await adminSiteGraphApi.deleteNode(node.id)
            toast.success("节点已删除")
            setNodeForm((current) => (current.id === node.id ? emptyNodeForm() : current))
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "删除节点失败"))
        }
    }), [fetchOverview, runWithBusy])

    const handleSaveEdge = React.useCallback(() => runWithBusy(async () => {
        if (!edgeForm.fromNodeId || !edgeForm.toNodeId) {
            toast.error("请选择关系的起点和终点")
            return
        }
        if (!edgeForm.relation.trim()) {
            toast.error("请填写关系名称")
            return
        }
        try {
            await adminSiteGraphApi.saveEdge({
                id: edgeForm.id,
                fromNodeId: edgeForm.fromNodeId,
                toNodeId: edgeForm.toNodeId,
                relation: edgeForm.relation.trim(),
                kind: edgeForm.kind,
                attributes: parseAttributesText(edgeForm.attributesText),
                weight: toPositiveInt(edgeForm.weight, 1),
                directed: edgeForm.directed,
                status: edgeForm.status,
                confidence: toPositiveInt(edgeForm.confidence, 100),
                locked: edgeForm.locked,
            })
            toast.success(edgeForm.id ? "关系已更新" : "关系已新增")
            setEdgeForm(emptyEdgeForm())
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "保存关系失败"))
        }
    }), [edgeForm, fetchOverview, runWithBusy])

    const handleDeleteEdge = React.useCallback((edge: SiteGraphAdminEdge) => runWithBusy(async () => {
        try {
            await adminSiteGraphApi.deleteEdge(edge.id)
            toast.success("关系已删除")
            setEdgeForm((current) => (current.id === edge.id ? emptyEdgeForm() : current))
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "删除关系失败"))
        }
    }), [fetchOverview, runWithBusy])

    const handleConfirmMerge = React.useCallback((candidate: SiteGraphMergeCandidate) => runWithBusy(async () => {
        if (!candidate.sourceNodeId || !candidate.targetNodeId) {
            toast.error("候选涉及的节点已不存在，请刷新")
            return
        }
        if (!window.confirm(`确定把「${candidate.sourceName}」并入「${candidate.targetName}」？来源节点会被删除，其关系与子节点改挂到目标节点。`)) {
            return
        }
        try {
            const res = await adminSiteGraphApi.confirmMerge(candidate.sourceNodeId, candidate.targetNodeId)
            const { movedEdges, droppedEdges, movedChildren, attributeConflicts } = res.data
            toast.success(`已合并：迁移 ${movedEdges} 条关系、${movedChildren} 个子节点，去重 ${droppedEdges} 条`)
            if (attributeConflicts > 0) {
                toast.warning(`有 ${attributeConflicts} 条同名属性取值不一致，已保留目标节点的值`)
            }
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "合并失败"))
        }
    }), [fetchOverview, runWithBusy])

    const handleIgnoreMerge = React.useCallback((candidate: SiteGraphMergeCandidate) => runWithBusy(async () => {
        try {
            await adminSiteGraphApi.ignoreMerge(candidate.id)
            toast.success("已忽略该候选，后续生成不会再提示")
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "忽略失败"))
        }
    }), [fetchOverview, runWithBusy])

    const filteredNodes = React.useMemo(() => {
        const nodes = overview?.nodes ?? []
        const query = nodeKeyword.trim().toLowerCase()
        if (!query) return nodes.slice(0, 200)
        return nodes
            .filter((node) =>
                node.name.toLowerCase().includes(query)
                || node.nodeKey.toLowerCase().includes(query)
                || node.summary.toLowerCase().includes(query))
            .slice(0, 200)
    }, [nodeKeyword, overview?.nodes])

    const nodeOptions = overview?.nodeOptions ?? []
    const mergeCandidates = overview?.mergeCandidates ?? []
    const validation = overview?.validation ?? null
    const latestRun = overview?.runs[0] ?? null
    const disabled = loading || busy || generating

    return (
        <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-1">
                    <h1 className="flex items-center gap-2 text-2xl font-semibold">
                        <Network className="size-6 text-primary" />
                        全站星图
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        由抽取 Agent 从公开文章生成「节点 + 属性 + 关系」，校验通过后发布到前台 `/graph`。
                        数据存在 PostgreSQL：层级走邻接表，跨树关系走关系表，查询用递归 CTE。
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => void fetchOverview()} disabled={disabled}>
                        {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
                        刷新
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void handleValidate()} disabled={disabled}>
                        <CheckCircle2 className="mr-2 size-4" />
                        重新校验
                    </Button>
                    <Button type="button" onClick={() => void handleGenerate()} disabled={disabled}>
                        {generating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
                        Agent 生成
                    </Button>
                    <Button type="button" onClick={() => void handlePublish()} disabled={disabled}>
                        <Send className="mr-2 size-4" />
                        发布到前台
                    </Button>
                </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                <Card>
                    <CardHeader>
                        <CardTitle>校验报告</CardTitle>
                        <CardDescription>
                            存在错误项时禁止发布。生成后自动校验一次，人工改动后可点「重新校验」。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {validation ? (
                            <>
                                <div className="flex flex-wrap items-center gap-3 text-sm">
                                    <span
                                        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 ${
                                            validation.passed
                                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                : "bg-destructive/10 text-destructive"
                                        }`}
                                    >
                                        {validation.passed ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
                                        {validation.passed ? "校验通过" : "校验未通过"}
                                    </span>
                                    <span className="text-muted-foreground">评分 {validation.score}</span>
                                    <span className="text-muted-foreground">最大层级 {validation.maxDepth}</span>
                                    <span className="text-muted-foreground">孤立节点 {validation.orphanCount}</span>
                                    <span className="text-muted-foreground">校验于 {formatDateTime(validation.checkedAt)}</span>
                                </div>
                                {validation.issues.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">没有发现问题。</p>
                                ) : (
                                    <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
                                        {validation.issues.map((issue, index) => (
                                            <IssueRow key={`${issue.code}-${issue.target}-${index}`} issue={issue} />
                                        ))}
                                    </ul>
                                )}
                            </>
                        ) : (
                            <p className="text-sm text-muted-foreground">尚无校验记录。</p>
                        )}
                    </CardContent>
                </Card>

                <div className="flex flex-col gap-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>星图概况</CardTitle>
                            <CardDescription>前台仅展示「已发布」的节点与关系。</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <StatRow label="节点总数" value={overview?.stats.nodeCount ?? 0} />
                            <StatRow label="关系总数" value={overview?.stats.edgeCount ?? 0} />
                            <StatRow label="已发布节点" value={overview?.stats.publishedNodes ?? 0} />
                            <StatRow label="草稿节点" value={overview?.stats.draftNodes ?? 0} />
                            <StatRow label="文章节点" value={overview?.stats.articleNodes ?? 0} />
                            <StatRow label="概念/实体节点" value={overview?.stats.conceptNodes ?? 0} />
                            <StatRow label="人工维护节点" value={overview?.stats.manualNodes ?? 0} />
                            <StatRow label="已锁定节点" value={overview?.stats.lockedNodes ?? 0} />
                            <div className="flex flex-col gap-2 pt-2">
                                <Button type="button" variant="outline" className="w-full" asChild>
                                    <a href="/graph" target="_blank" rel="noopener noreferrer">预览前台星图</a>
                                </Button>
                                <Button type="button" variant="outline" className="w-full" onClick={() => void handleUnpublish()} disabled={disabled}>
                                    <Undo2 className="mr-2 size-4" />
                                    全部下线
                                </Button>
                                <Button type="button" variant="destructive" className="w-full" onClick={() => void handleClear()} disabled={disabled}>
                                    <Trash2 className="mr-2 size-4" />
                                    清空星图
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>最近一次生成</CardTitle>
                            <CardDescription>抽取 Agent 的运行记录。</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            {latestRun ? (
                                <>
                                    <StatRow label="状态" value={latestRun.status} />
                                    <StatRow label="模型" value={latestRun.modelName ?? "—"} />
                                    <StatRow label="文章数" value={latestRun.articleCount} />
                                    <StatRow label="节点/关系" value={`${latestRun.nodeCount} / ${latestRun.edgeCount}`} />
                                    <StatRow label="开始时间" value={formatDateTime(latestRun.startedAt)} />
                                    <StatRow label="结束时间" value={formatDateTime(latestRun.finishedAt)} />
                                    {latestRun.errorMessage ? (
                                        <p className="text-xs text-destructive">{latestRun.errorMessage}</p>
                                    ) : null}
                                    {latestRun.warnings.length > 0 ? (
                                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                                            {latestRun.warnings.map((warning) => (
                                                <li key={warning}>{warning}</li>
                                            ))}
                                        </ul>
                                    ) : null}
                                </>
                            ) : (
                                <p className="text-muted-foreground">尚未运行过抽取 Agent。</p>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Merge className="size-4" />
                        待确认的实体合并
                        {mergeCandidates.length > 0 ? (
                            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                                {mergeCandidates.length}
                            </span>
                        ) : null}
                    </CardTitle>
                    <CardDescription>
                        名称/别名规范化后完全一致的实体在抽取阶段已自动合并；这里只列「名称相近但拿不准」的对子。
                        确认后来源节点并入目标节点并被删除，忽略后不再提示。
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {mergeCandidates.length === 0 ? (
                        <p className="text-sm text-muted-foreground">没有待确认的合并候选。</p>
                    ) : (
                        <ul className="space-y-2">
                            {mergeCandidates.map((candidate) => (
                                <li
                                    key={candidate.id}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2 text-sm">
                                            <span className="font-medium">{candidate.sourceName}</span>
                                            <span className="text-muted-foreground">并入</span>
                                            <span className="font-medium">{candidate.targetName}</span>
                                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                                相似度 {candidate.score}%
                                            </span>
                                        </div>
                                        <p className="mt-0.5 text-xs text-muted-foreground">
                                            {candidate.detail ?? candidate.reason}
                                            <span className="ml-2 opacity-70">
                                                {candidate.sourceKey} → {candidate.targetKey}
                                            </span>
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 gap-2">
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() => void handleConfirmMerge(candidate)}
                                        >
                                            <Merge className="mr-1.5 size-3.5" />
                                            确认合并
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            disabled={disabled}
                                            onClick={() => void handleIgnoreMerge(candidate)}
                                        >
                                            <X className="mr-1.5 size-3.5" />
                                            忽略
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{nodeForm.id ? "编辑节点" : "新增节点"}</CardTitle>
                    <CardDescription>
                        节点键留空时按「类型-名称」自动生成。手工保存的节点会标记为人工维护，Agent 重跑不会覆盖；
                        勾选「锁定」后连属性也不会被覆盖。属性每行一条，格式为 `名称=值`。
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">节点名称</Label>
                            <Input
                                value={nodeForm.name}
                                disabled={disabled}
                                onChange={(event) => setNodeForm((current) => ({ ...current, name: event.target.value }))}
                                placeholder="向量检索"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">节点类型</Label>
                            <Select
                                value={nodeForm.kind}
                                disabled={disabled}
                                onValueChange={(value) => setNodeForm((current) => ({ ...current, kind: value as SiteGraphNodeKind }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {NODE_KIND_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">父节点（邻接表）</Label>
                            <Select
                                value={nodeForm.parentId}
                                disabled={disabled}
                                onValueChange={(value) => setNodeForm((current) => ({ ...current, parentId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NONE_PARENT}>（无父节点）</SelectItem>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">节点键（可空）</Label>
                            <Input
                                value={nodeForm.nodeKey}
                                disabled={disabled}
                                onChange={(event) => setNodeForm((current) => ({ ...current, nodeKey: event.target.value }))}
                                placeholder="concept-向量检索"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">站内链接（可空，必须以 / 开头）</Label>
                            <Input
                                value={nodeForm.route}
                                disabled={disabled}
                                onChange={(event) => setNodeForm((current) => ({ ...current, route: event.target.value }))}
                                placeholder="/p/abcd1234"
                            />
                        </div>
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">摘要（前台悬停展示）</Label>
                        <Textarea
                            value={nodeForm.summary}
                            disabled={disabled}
                            rows={2}
                            onChange={(event) => setNodeForm((current) => ({ ...current, summary: event.target.value }))}
                        />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">节点属性（每行 `名称=值`）</Label>
                            <Textarea
                                value={nodeForm.attributesText}
                                disabled={disabled}
                                rows={4}
                                onChange={(event) => setNodeForm((current) => ({ ...current, attributesText: event.target.value }))}
                                placeholder={"类别=检索技术\n典型场景=RAG 问答"}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">别名（逗号分隔）</Label>
                            <Textarea
                                value={nodeForm.aliasesText}
                                disabled={disabled}
                                rows={4}
                                onChange={(event) => setNodeForm((current) => ({ ...current, aliasesText: event.target.value }))}
                                placeholder="vector search, 向量搜索"
                            />
                        </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-4">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">权重（影响点半径）</Label>
                            <Input
                                type="number"
                                value={nodeForm.weight}
                                disabled={disabled}
                                onChange={(event) => setNodeForm((current) => ({ ...current, weight: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">置信度</Label>
                            <Input
                                type="number"
                                value={nodeForm.confidence}
                                disabled={disabled}
                                onChange={(event) => setNodeForm((current) => ({ ...current, confidence: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">状态</Label>
                            <Select
                                value={nodeForm.status}
                                disabled={disabled}
                                onValueChange={(value) => setNodeForm((current) => ({ ...current, status: value as SiteGraphStatus }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {STATUS_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex items-end gap-2 pb-2">
                            <Switch
                                id="node-locked"
                                checked={nodeForm.locked}
                                disabled={disabled}
                                onCheckedChange={(checked) => setNodeForm((current) => ({ ...current, locked: checked }))}
                            />
                            <Label htmlFor="node-locked" className="text-xs text-muted-foreground">锁定（Agent 不覆盖）</Label>
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <Button type="button" onClick={() => void handleSaveNode()} disabled={disabled}>
                            <Plus className="mr-2 size-4" />
                            {nodeForm.id ? "保存修改" : "新增节点"}
                        </Button>
                        {nodeForm.id ? (
                            <Button type="button" variant="outline" onClick={() => setNodeForm(emptyNodeForm())} disabled={disabled}>
                                取消编辑
                            </Button>
                        ) : null}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>节点列表</CardTitle>
                    <CardDescription>共 {overview?.nodes.length ?? 0} 个节点，最多展示 200 条。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Input
                        value={nodeKeyword}
                        disabled={disabled}
                        onChange={(event) => setNodeKeyword(event.target.value)}
                        placeholder="搜索节点名称 / 节点键 / 摘要"
                    />
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[52rem] text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr className="border-b">
                                    <th className="py-2 text-left font-medium">名称</th>
                                    <th className="py-2 text-left font-medium">类型</th>
                                    <th className="py-2 text-left font-medium">父节点</th>
                                    <th className="py-2 text-right font-medium">层级</th>
                                    <th className="py-2 text-right font-medium">子/关系</th>
                                    <th className="py-2 text-left font-medium">属性</th>
                                    <th className="py-2 text-left font-medium">状态</th>
                                    <th className="py-2 text-right font-medium">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredNodes.length === 0 ? (
                                    <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">暂无节点</td></tr>
                                ) : filteredNodes.map((node) => (
                                    <tr key={node.id} className="border-b last:border-0">
                                        <td className="py-2 pr-2">
                                            <div className="font-medium">{node.name}</div>
                                            <div className="text-xs text-muted-foreground">{node.nodeKey}</div>
                                        </td>
                                        <td className="py-2 pr-2">{KIND_LABEL[node.kind]}</td>
                                        <td className="py-2 pr-2 text-xs text-muted-foreground">{node.parentKey ?? "—"}</td>
                                        <td className="py-2 pr-2 text-right">{node.depth}</td>
                                        <td className="py-2 pr-2 text-right">{node.childCount} / {node.degree}</td>
                                        <td className="py-2 pr-2 text-xs text-muted-foreground">
                                            {node.attributes.length === 0
                                                ? "—"
                                                : node.attributes.slice(0, 2).map((attribute) => `${attribute.name}:${attribute.value}`).join("；")}
                                        </td>
                                        <td className="py-2 pr-2">
                                            <span className="inline-flex items-center gap-1 text-xs">
                                                {node.locked ? <Lock className="size-3" /> : <LockOpen className="size-3 opacity-40" />}
                                                {STATUS_OPTIONS.find((option) => option.value === node.status)?.label ?? node.status}
                                                <span className="text-muted-foreground">/{node.source}</span>
                                            </span>
                                        </td>
                                        <td className="py-2 text-right">
                                            <div className="flex justify-end gap-1">
                                                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setNodeForm(toNodeForm(node))}>
                                                    编辑
                                                </Button>
                                                <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label="删除节点" onClick={() => void handleDeleteNode(node)}>
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{edgeForm.id ? "编辑关系" : "新增关系"}</CardTitle>
                    <CardDescription>关系用于连接不同分支的节点；父子层级请在节点表单里用「父节点」维护。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">起点</Label>
                            <Select
                                value={edgeForm.fromNodeId}
                                disabled={disabled}
                                onValueChange={(value) => setEdgeForm((current) => ({ ...current, fromNodeId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue placeholder="选择起点节点" /></SelectTrigger>
                                <SelectContent>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">关系名称</Label>
                            <Input
                                value={edgeForm.relation}
                                disabled={disabled}
                                onChange={(event) => setEdgeForm((current) => ({ ...current, relation: event.target.value }))}
                                placeholder="阐述"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">终点</Label>
                            <Select
                                value={edgeForm.toNodeId}
                                disabled={disabled}
                                onValueChange={(value) => setEdgeForm((current) => ({ ...current, toNodeId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue placeholder="选择终点节点" /></SelectTrigger>
                                <SelectContent>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">关系属性（每行 `名称=值`）</Label>
                            <Textarea
                                value={edgeForm.attributesText}
                                disabled={disabled}
                                rows={3}
                                onChange={(event) => setEdgeForm((current) => ({ ...current, attributesText: event.target.value }))}
                                placeholder="依据=文中第 2 节"
                            />
                        </div>
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">关系类型</Label>
                                <Select
                                    value={edgeForm.kind}
                                    disabled={disabled}
                                    onValueChange={(value) => setEdgeForm((current) => ({ ...current, kind: value as SiteGraphEdgeKind }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {EDGE_KIND_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">状态</Label>
                                <Select
                                    value={edgeForm.status}
                                    disabled={disabled}
                                    onValueChange={(value) => setEdgeForm((current) => ({ ...current, status: value as SiteGraphStatus }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {STATUS_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">权重</Label>
                                <Input
                                    type="number"
                                    value={edgeForm.weight}
                                    disabled={disabled}
                                    onChange={(event) => setEdgeForm((current) => ({ ...current, weight: event.target.value }))}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">置信度</Label>
                                <Input
                                    type="number"
                                    value={edgeForm.confidence}
                                    disabled={disabled}
                                    onChange={(event) => setEdgeForm((current) => ({ ...current, confidence: event.target.value }))}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-6">
                        <div className="flex items-center gap-2">
                            <Switch
                                id="edge-directed"
                                checked={edgeForm.directed}
                                disabled={disabled}
                                onCheckedChange={(checked) => setEdgeForm((current) => ({ ...current, directed: checked }))}
                            />
                            <Label htmlFor="edge-directed" className="text-xs text-muted-foreground">有向关系</Label>
                        </div>
                        <div className="flex items-center gap-2">
                            <Switch
                                id="edge-locked"
                                checked={edgeForm.locked}
                                disabled={disabled}
                                onCheckedChange={(checked) => setEdgeForm((current) => ({ ...current, locked: checked }))}
                            />
                            <Label htmlFor="edge-locked" className="text-xs text-muted-foreground">锁定（Agent 不覆盖）</Label>
                        </div>
                        <div className="flex gap-2">
                            <Button type="button" onClick={() => void handleSaveEdge()} disabled={disabled}>
                                <Plus className="mr-2 size-4" />
                                {edgeForm.id ? "保存修改" : "新增关系"}
                            </Button>
                            {edgeForm.id ? (
                                <Button type="button" variant="outline" onClick={() => setEdgeForm(emptyEdgeForm())} disabled={disabled}>
                                    取消编辑
                                </Button>
                            ) : null}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>关系列表</CardTitle>
                    <CardDescription>共 {overview?.edges.length ?? 0} 条关系。</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[46rem] text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr className="border-b">
                                    <th className="py-2 text-left font-medium">起点</th>
                                    <th className="py-2 text-left font-medium">关系</th>
                                    <th className="py-2 text-left font-medium">终点</th>
                                    <th className="py-2 text-left font-medium">类型</th>
                                    <th className="py-2 text-right font-medium">权重/置信</th>
                                    <th className="py-2 text-left font-medium">状态</th>
                                    <th className="py-2 text-right font-medium">操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(overview?.edges ?? []).length === 0 ? (
                                    <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">暂无关系</td></tr>
                                ) : (overview?.edges ?? []).slice(0, 300).map((edge) => (
                                    <tr key={edge.id} className="border-b last:border-0">
                                        <td className="py-2 pr-2">{edge.fromNodeName}</td>
                                        <td className="py-2 pr-2 font-medium">{edge.relation}</td>
                                        <td className="py-2 pr-2">{edge.toNodeName}</td>
                                        <td className="py-2 pr-2 text-xs text-muted-foreground">
                                            {EDGE_KIND_OPTIONS.find((option) => option.value === edge.kind)?.label ?? edge.kind}
                                        </td>
                                        <td className="py-2 pr-2 text-right">{edge.weight} / {edge.confidence}</td>
                                        <td className="py-2 pr-2">
                                            <span className="inline-flex items-center gap-1 text-xs">
                                                {edge.locked ? <Lock className="size-3" /> : <LockOpen className="size-3 opacity-40" />}
                                                {STATUS_OPTIONS.find((option) => option.value === edge.status)?.label ?? edge.status}
                                            </span>
                                        </td>
                                        <td className="py-2 text-right">
                                            <div className="flex justify-end gap-1">
                                                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setEdgeForm(toEdgeForm(edge))}>
                                                    编辑
                                                </Button>
                                                <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label="删除关系" onClick={() => void handleDeleteEdge(edge)}>
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{label}</span>
            <span className="text-right">{value}</span>
        </div>
    )
}

function IssueRow({ issue }: { issue: SiteGraphIssue }) {
    const meta = SEVERITY_META[issue.severity]
    const Icon = meta.icon
    return (
        <li className="flex items-start gap-2">
            <Icon className={`mt-0.5 size-3.5 shrink-0 ${meta.className}`} />
            <span className="min-w-0">
                <span className={meta.className}>[{meta.label}]</span>{" "}
                <span className="text-muted-foreground">{issue.target}</span>{" "}
                {issue.message}
            </span>
        </li>
    )
}
