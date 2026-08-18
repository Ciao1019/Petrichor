"use client"

import * as React from "react"
import {
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    ExternalLink,
    Info,
    Link2,
    Loader2,
    Lock,
    LockOpen,
    Merge,
    MoreHorizontal,
    Network,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Send,
    Sparkles,
    Trash2,
    Undo2,
    X,
} from "@/components/iconimate"
import { toast } from "sonner"

import {
    SiteGraphAdminExplorer,
    type SiteGraphScope,
} from "@/components/site-graph/SiteGraphAdminExplorer"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
    type SiteGraphRunSummary,
    type SiteGraphSource,
    type SiteGraphStatus,
    type SiteGraphValidationReport,
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

/** 与前台 /graph 共用同一套点群配色（定义在 app/site-graph.css），后台的类型点因此和星图对得上 */
const KIND_COLOR_VAR: Record<SiteGraphNodeKind, string> = {
    root: "--site-graph-root",
    section: "--site-graph-section",
    article: "--site-graph-article",
    concept: "--site-graph-concept",
    entity: "--site-graph-entity",
    tag: "--site-graph-tag",
}

const STATUS_META: Record<SiteGraphStatus, { label: string; className: string }> = {
    PUBLISHED: {
        label: "已发布",
        className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
    DRAFT: {
        label: "草稿",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    },
    ARCHIVED: {
        label: "已归档",
        className: "border-border bg-muted text-muted-foreground",
    },
}

const SOURCE_LABEL: Record<SiteGraphSource, string> = {
    AGENT: "Agent",
    MANUAL: "人工",
    SYSTEM: "系统",
}

const RUN_STATUS_META: Record<SiteGraphRunSummary["status"], { label: string; className: string }> = {
    RUNNING: { label: "运行中", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    COMPLETED: { label: "已完成", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    FAILED: { label: "失败", className: "border-destructive/30 bg-destructive/10 text-destructive" },
}

const SEVERITY_META = {
    error: { label: "错误", icon: AlertTriangle, className: "text-destructive", dot: "bg-destructive" },
    warning: { label: "警告", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
    info: { label: "提示", icon: Info, className: "text-muted-foreground", dot: "bg-muted-foreground/50" },
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

/** 确认弹窗统一走一份状态，避免每个危险动作各挂一个 AlertDialog */
interface ConfirmState {
    title: string
    description: React.ReactNode
    actionLabel: string
    destructive?: boolean
    run: () => Promise<void>
}

const NONE_PARENT = "__none__"
const ALL_FILTER = "__all__"

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
    const [nodeSheetOpen, setNodeSheetOpen] = React.useState(false)
    const [edgeSheetOpen, setEdgeSheetOpen] = React.useState(false)
    const [nodeKeyword, setNodeKeyword] = React.useState("")
    const [nodeKindFilter, setNodeKindFilter] = React.useState<string>(ALL_FILTER)
    const [nodeStatusFilter, setNodeStatusFilter] = React.useState<string>(ALL_FILTER)
    const [edgeKeyword, setEdgeKeyword] = React.useState("")
    const [graphScope, setGraphScope] = React.useState<SiteGraphScope>("all")
    const [confirm, setConfirm] = React.useState<ConfirmState | null>(null)
    const [confirmRunning, setConfirmRunning] = React.useState(false)

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
            setNodeSheetOpen(false)
            await fetchOverview()
        } catch (e: unknown) {
            toast.error(resolveApiError(e, "保存节点失败"))
        }
    }), [fetchOverview, nodeForm, runWithBusy])

    const handleDeleteNode = React.useCallback((node: SiteGraphAdminNode) => runWithBusy(async () => {
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
            setEdgeSheetOpen(false)
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

    const openNodeSheet = React.useCallback((node?: SiteGraphAdminNode) => {
        setNodeForm(node ? toNodeForm(node) : emptyNodeForm())
        setNodeSheetOpen(true)
    }, [])

    const openEdgeSheet = React.useCallback((edge?: SiteGraphAdminEdge) => {
        setEdgeForm(edge ? toEdgeForm(edge) : emptyEdgeForm())
        setEdgeSheetOpen(true)
    }, [])

    const runConfirm = React.useCallback(async () => {
        if (!confirm) return
        setConfirmRunning(true)
        try {
            await confirm.run()
            setConfirm(null)
        } finally {
            setConfirmRunning(false)
        }
    }, [confirm])

    const filteredNodes = React.useMemo(() => {
        const nodes = overview?.nodes ?? []
        const query = nodeKeyword.trim().toLowerCase()
        return nodes
            .filter((node) => (nodeKindFilter === ALL_FILTER ? true : node.kind === nodeKindFilter))
            .filter((node) => (nodeStatusFilter === ALL_FILTER ? true : node.status === nodeStatusFilter))
            .filter((node) =>
                !query
                || node.name.toLowerCase().includes(query)
                || node.nodeKey.toLowerCase().includes(query)
                || node.summary.toLowerCase().includes(query))
            .slice(0, 200)
    }, [nodeKeyword, nodeKindFilter, nodeStatusFilter, overview?.nodes])

    const filteredEdges = React.useMemo(() => {
        const edges = overview?.edges ?? []
        const query = edgeKeyword.trim().toLowerCase()
        if (!query) return edges.slice(0, 300)
        return edges
            .filter((edge) =>
                edge.relation.toLowerCase().includes(query)
                || edge.fromNodeName.toLowerCase().includes(query)
                || edge.toNodeName.toLowerCase().includes(query))
            .slice(0, 300)
    }, [edgeKeyword, overview?.edges])

    const nodeOptions = overview?.nodeOptions ?? []
    const mergeCandidates = overview?.mergeCandidates ?? []
    const validation = overview?.validation ?? null
    const latestRun = overview?.runs[0] ?? null
    const stats = overview?.stats ?? null
    const disabled = loading || busy || generating

    const nodeFilterActive = Boolean(nodeKeyword.trim()) || nodeKindFilter !== ALL_FILTER || nodeStatusFilter !== ALL_FILTER

    return (
        <div className="mx-auto flex w-full max-w-[104rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
            {/* 头部：标题 + 状态摘要 + 主操作。次要与危险动作收进「更多」，避免一排同权重按钮 */}
            <header className="relative overflow-hidden rounded-2xl border bg-card">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                    style={{
                        background:
                            "radial-gradient(120% 150% at 0% 0%, color-mix(in oklab, var(--primary) 12%, transparent), transparent 55%)",
                    }}
                />
                <div className="relative flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-2">
                        <div className="flex items-center gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background/70 text-primary shadow-sm">
                                <Network className="size-5" />
                            </span>
                            <div className="min-w-0">
                                <h1 className="text-xl font-semibold tracking-tight">全站星图</h1>
                                <p className="text-sm text-muted-foreground">
                                    抽取 Agent 从公开文章生成「节点 + 属性 + 关系」，校验通过后发布到前台 <code className="rounded bg-muted px-1 py-0.5 text-xs">/graph</code>
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            {loading && !validation ? (
                                <Skeleton className="h-6 w-56" />
                            ) : validation ? (
                                <>
                                    <Badge
                                        variant="outline"
                                        className={`gap-1.5 ${validation.passed
                                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                            : "border-destructive/30 bg-destructive/10 text-destructive"}`}
                                    >
                                        {validation.passed ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
                                        {validation.passed ? "校验通过" : "校验未通过"}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">评分 {validation.score}</span>
                                    <MetaDivider />
                                    <span className="text-xs text-muted-foreground">
                                        已发布 {stats?.publishedNodes ?? 0} 节点
                                    </span>
                                    <MetaDivider />
                                    <span className="text-xs text-muted-foreground">
                                        校验于 {formatDateTime(validation.checkedAt)}
                                    </span>
                                </>
                            ) : null}
                        </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => void fetchOverview()} disabled={disabled}>
                            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            刷新
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => void handleValidate()} disabled={disabled}>
                            <CheckCircle2 />
                            重新校验
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => void handleGenerate()} disabled={disabled}>
                            {generating ? <Loader2 className="animate-spin" /> : <Sparkles className="text-primary" />}
                            Agent 生成
                        </Button>
                        <Button type="button" size="sm" onClick={() => void handlePublish()} disabled={disabled}>
                            <Send />
                            发布到前台
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" aria-label="更多操作" disabled={disabled}>
                                    <MoreHorizontal />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem asChild>
                                    <a href="/graph" target="_blank" rel="noopener noreferrer">
                                        <ExternalLink />
                                        预览前台星图
                                    </a>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() => setConfirm({
                                        title: "把星图全部下线？",
                                        description: "所有已发布的节点与关系会退回草稿，前台 /graph 将立即看不到内容。",
                                        actionLabel: "确认下线",
                                        run: handleUnpublish,
                                    })}
                                >
                                    <Undo2 />
                                    全部下线
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => setConfirm({
                                        title: "确定清空整个全站星图？",
                                        description: "人工维护的节点与关系也会一并删除，且不可撤销。",
                                        actionLabel: "确认清空",
                                        destructive: true,
                                        run: handleClear,
                                    })}
                                >
                                    <Trash2 />
                                    清空星图
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>

                {/* 类型图例：表格与星图共用这套颜色，放在头部当索引 */}
                <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t bg-muted/30 px-5 py-2.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">节点类型</span>
                    {NODE_KIND_OPTIONS.map((option) => (
                        <span key={option.value} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <KindDot kind={option.value} />
                            {option.label}
                        </span>
                    ))}
                </div>
            </header>

            {/* 指标条：原来是窄侧栏里的 8 行「标签 / 数字」，横排成卡片后一眼能扫完 */}
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
                {loading && !stats
                    ? Array.from({ length: 8 }).map((_, index) => (
                        <Skeleton key={index} className="h-[4.75rem] rounded-xl" />
                    ))
                    : (
                        <>
                            <StatTile label="节点总数" value={stats?.nodeCount ?? 0} accent="var(--primary)" />
                            <StatTile label="关系总数" value={stats?.edgeCount ?? 0} accent="var(--primary)" />
                            <StatTile label="已发布节点" value={stats?.publishedNodes ?? 0} accent="var(--color-emerald-500)" />
                            <StatTile label="草稿节点" value={stats?.draftNodes ?? 0} accent="var(--color-amber-500)" />
                            <StatTile label="文章节点" value={stats?.articleNodes ?? 0} accent="var(--site-graph-article)" />
                            <StatTile label="概念 / 实体" value={stats?.conceptNodes ?? 0} accent="var(--site-graph-concept)" />
                            <StatTile label="人工维护" value={stats?.manualNodes ?? 0} accent="var(--site-graph-entity)" />
                            <StatTile label="已锁定" value={stats?.lockedNodes ?? 0} accent="var(--site-graph-tag)" />
                        </>
                    )}
            </section>

            <Tabs defaultValue="overview" className="gap-4">
                <TabsList className="h-9">
                    <TabsTrigger value="overview">总览</TabsTrigger>
                    <TabsTrigger value="graph" className="gap-1.5">
                        <Network className="size-3.5" />
                        图谱
                    </TabsTrigger>
                    <TabsTrigger value="nodes" className="gap-1.5">
                        节点
                        <span className="rounded bg-muted px-1 text-[11px] tabular-nums text-muted-foreground">
                            {overview?.nodes.length ?? 0}
                        </span>
                    </TabsTrigger>
                    <TabsTrigger value="edges" className="gap-1.5">
                        关系
                        <span className="rounded bg-muted px-1 text-[11px] tabular-nums text-muted-foreground">
                            {overview?.edges.length ?? 0}
                        </span>
                    </TabsTrigger>
                    <TabsTrigger value="merges" className="gap-1.5">
                        合并候选
                        {mergeCandidates.length > 0 ? (
                            <span className="rounded bg-amber-500/20 px-1 text-[11px] tabular-nums text-amber-700 dark:text-amber-400">
                                {mergeCandidates.length}
                            </span>
                        ) : null}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                    <ValidationPanel validation={validation} loading={loading && !validation} />
                    <RunPanel run={latestRun} loading={loading && !overview} />
                </TabsContent>

                <TabsContent value="graph">
                    {loading && !overview ? (
                        <Skeleton className="h-[30rem] w-full rounded-xl xl:h-[36rem]" />
                    ) : (
                        <SiteGraphAdminExplorer
                            nodes={overview?.nodes ?? []}
                            edges={overview?.edges ?? []}
                            scope={graphScope}
                            onScopeChange={setGraphScope}
                            onEditNode={openNodeSheet}
                        />
                    )}
                </TabsContent>

                <TabsContent value="nodes" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-0 flex-1 sm:max-w-xs">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={nodeKeyword}
                                disabled={disabled}
                                onChange={(event) => setNodeKeyword(event.target.value)}
                                placeholder="搜索名称 / 节点键 / 摘要"
                                className="h-9 pl-8"
                            />
                        </div>
                        <Select value={nodeKindFilter} onValueChange={setNodeKindFilter} disabled={disabled}>
                            <SelectTrigger size="sm" className="w-[7.5rem]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_FILTER}>全部类型</SelectItem>
                                {NODE_KIND_OPTIONS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={nodeStatusFilter} onValueChange={setNodeStatusFilter} disabled={disabled}>
                            <SelectTrigger size="sm" className="w-[7.5rem]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_FILTER}>全部状态</SelectItem>
                                {STATUS_OPTIONS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {nodeFilterActive ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    setNodeKeyword("")
                                    setNodeKindFilter(ALL_FILTER)
                                    setNodeStatusFilter(ALL_FILTER)
                                }}
                            >
                                <X />
                                清除筛选
                            </Button>
                        ) : null}
                        <span className="ml-auto text-xs text-muted-foreground">
                            显示 {filteredNodes.length} / {overview?.nodes.length ?? 0}（最多 200 条）
                        </span>
                        <Button type="button" size="sm" onClick={() => openNodeSheet()} disabled={disabled}>
                            <Plus />
                            新增节点
                        </Button>
                    </div>

                    <div className="overflow-hidden rounded-xl border bg-card">
                        {loading && !overview ? (
                            <TableSkeleton columns={7} />
                        ) : filteredNodes.length === 0 ? (
                            <Empty className="border-0">
                                <EmptyHeader>
                                    <EmptyMedia variant="icon"><Network /></EmptyMedia>
                                    <EmptyTitle>{nodeFilterActive ? "没有匹配的节点" : "还没有节点"}</EmptyTitle>
                                    <EmptyDescription>
                                        {nodeFilterActive ? "换个关键词或清除筛选试试。" : "点「Agent 生成」从公开文章抽取，或手动新增一个节点。"}
                                    </EmptyDescription>
                                </EmptyHeader>
                            </Empty>
                        ) : (
                            <div className="max-h-[38rem] overflow-y-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                                            {/* w-full 让富余宽度全落在名称列：其余列按内容收紧，右侧不再出现大片空档 */}
                                            <TableHead className="w-full pl-4">节点</TableHead>
                                            <TableHead>类型</TableHead>
                                            <TableHead>父节点</TableHead>
                                            <TableHead className="text-right">层级</TableHead>
                                            <TableHead className="text-right">子 / 关系</TableHead>
                                            <TableHead>属性</TableHead>
                                            <TableHead>状态</TableHead>
                                            <TableHead className="pr-4 text-right">操作</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {filteredNodes.map((node) => (
                                            <TableRow key={node.id} className="group">
                                                <TableCell className="max-w-0 pl-4">
                                                    <div className="truncate font-medium">{node.name}</div>
                                                    <div className="truncate font-mono text-[11px] text-muted-foreground">{node.nodeKey}</div>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="inline-flex items-center gap-1.5 text-xs">
                                                        <KindDot kind={node.kind} />
                                                        {KIND_LABEL[node.kind]}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="max-w-[12rem]">
                                                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                                        {node.parentKey ?? "—"}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums text-muted-foreground">{node.depth}</TableCell>
                                                <TableCell className="text-right tabular-nums text-muted-foreground">
                                                    {node.childCount} / {node.degree}
                                                </TableCell>
                                                <TableCell className="max-w-[16rem]">
                                                    {node.attributes.length === 0 ? (
                                                        <span className="text-xs text-muted-foreground">—</span>
                                                    ) : (
                                                        <div className="flex items-center gap-1">
                                                            {node.attributes.slice(0, 2).map((attribute) => (
                                                                <span
                                                                    key={attribute.name}
                                                                    title={`${attribute.name}：${attribute.value}`}
                                                                    className="max-w-[7rem] truncate rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                                                >
                                                                    {attribute.name}: {attribute.value}
                                                                </span>
                                                            ))}
                                                            {node.attributes.length > 2 ? (
                                                                <span className="text-[11px] text-muted-foreground">
                                                                    +{node.attributes.length - 2}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-1.5">
                                                        <StatusBadge status={node.status} />
                                                        <LockMark locked={node.locked} />
                                                        <span className="text-[11px] text-muted-foreground">{SOURCE_LABEL[node.source]}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="pr-4 text-right">
                                                    <RowActions
                                                        disabled={disabled}
                                                        editLabel="编辑节点"
                                                        deleteLabel="删除节点"
                                                        onEdit={() => openNodeSheet(node)}
                                                        onDelete={() => setConfirm({
                                                            title: `删除节点「${node.name}」？`,
                                                            description: "该节点的关系会一并删除，其子节点将变为无父节点。",
                                                            actionLabel: "确认删除",
                                                            destructive: true,
                                                            run: () => handleDeleteNode(node),
                                                        })}
                                                    />
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="edges" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-0 flex-1 sm:max-w-xs">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={edgeKeyword}
                                disabled={disabled}
                                onChange={(event) => setEdgeKeyword(event.target.value)}
                                placeholder="搜索关系名称 / 起点 / 终点"
                                className="h-9 pl-8"
                            />
                        </div>
                        <span className="ml-auto text-xs text-muted-foreground">
                            显示 {filteredEdges.length} / {overview?.edges.length ?? 0}（最多 300 条）
                        </span>
                        <Button type="button" size="sm" onClick={() => openEdgeSheet()} disabled={disabled}>
                            <Plus />
                            新增关系
                        </Button>
                    </div>

                    <div className="overflow-hidden rounded-xl border bg-card">
                        {loading && !overview ? (
                            <TableSkeleton columns={5} />
                        ) : filteredEdges.length === 0 ? (
                            <Empty className="border-0">
                                <EmptyHeader>
                                    <EmptyMedia variant="icon"><Link2 /></EmptyMedia>
                                    <EmptyTitle>{edgeKeyword.trim() ? "没有匹配的关系" : "还没有关系"}</EmptyTitle>
                                    <EmptyDescription>
                                        关系用于连接不同分支的节点；父子层级请在节点表单里用「父节点」维护。
                                    </EmptyDescription>
                                </EmptyHeader>
                            </Empty>
                        ) : (
                            <div className="max-h-[38rem] overflow-y-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                                            <TableHead className="pl-4">关系</TableHead>
                                            <TableHead>类型</TableHead>
                                            <TableHead className="text-right">权重 / 置信</TableHead>
                                            <TableHead>状态</TableHead>
                                            <TableHead className="pr-4 text-right">操作</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {filteredEdges.map((edge) => (
                                            <TableRow key={edge.id} className="group">
                                                <TableCell className="pl-4">
                                                    <div className="flex max-w-[36rem] items-center gap-2">
                                                        <span className="truncate font-medium">{edge.fromNodeName}</span>
                                                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                                                            {edge.relation}
                                                            {edge.directed ? <ArrowRight className="size-3" /> : null}
                                                        </span>
                                                        <span className="truncate font-medium">{edge.toNodeName}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-xs text-muted-foreground">
                                                    {EDGE_KIND_OPTIONS.find((option) => option.value === edge.kind)?.label ?? edge.kind}
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums text-muted-foreground">
                                                    {edge.weight} / {edge.confidence}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-1.5">
                                                        <StatusBadge status={edge.status} />
                                                        <LockMark locked={edge.locked} />
                                                        <span className="text-[11px] text-muted-foreground">{SOURCE_LABEL[edge.source]}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="pr-4 text-right">
                                                    <RowActions
                                                        disabled={disabled}
                                                        editLabel="编辑关系"
                                                        deleteLabel="删除关系"
                                                        onEdit={() => openEdgeSheet(edge)}
                                                        onDelete={() => setConfirm({
                                                            title: "删除这条关系？",
                                                            description: `「${edge.fromNodeName} — ${edge.relation} — ${edge.toNodeName}」将被移除。`,
                                                            actionLabel: "确认删除",
                                                            destructive: true,
                                                            run: () => handleDeleteEdge(edge),
                                                        })}
                                                    />
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="merges" className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                        名称/别名规范化后完全一致的实体在抽取阶段已自动合并；这里只列「名称相近但拿不准」的对子。
                        确认后来源节点并入目标节点并被删除，忽略后不再提示。
                    </p>
                    {mergeCandidates.length === 0 ? (
                        <div className="rounded-xl border bg-card">
                            <Empty className="border-0">
                                <EmptyHeader>
                                    <EmptyMedia variant="icon"><Merge /></EmptyMedia>
                                    <EmptyTitle>没有待确认的合并候选</EmptyTitle>
                                    <EmptyDescription>下次 Agent 生成时若发现相近实体，会出现在这里。</EmptyDescription>
                                </EmptyHeader>
                            </Empty>
                        </div>
                    ) : (
                        <ul className="grid gap-3 lg:grid-cols-2">
                            {mergeCandidates.map((candidate) => (
                                <li key={candidate.id} className="rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                                            <span className="truncate font-medium">{candidate.sourceName}</span>
                                            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span className="truncate font-medium">{candidate.targetName}</span>
                                        </div>
                                        <Badge variant="outline" className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-700 tabular-nums dark:text-amber-400">
                                            {candidate.score}%
                                        </Badge>
                                    </div>
                                    <p className="mt-1.5 text-xs text-muted-foreground">{candidate.detail ?? candidate.reason}</p>
                                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                                        {candidate.sourceKey} → {candidate.targetKey}
                                    </p>
                                    <div className="mt-3 flex gap-2">
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() => setConfirm({
                                                title: "确认合并这两个实体？",
                                                description: `「${candidate.sourceName}」将并入「${candidate.targetName}」：来源节点会被删除，其关系与子节点改挂到目标节点。`,
                                                actionLabel: "确认合并",
                                                run: () => handleConfirmMerge(candidate),
                                            })}
                                        >
                                            <Merge />
                                            确认合并
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            disabled={disabled}
                                            onClick={() => void handleIgnoreMerge(candidate)}
                                        >
                                            <X />
                                            忽略
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </TabsContent>
            </Tabs>

            <NodeFormSheet
                open={nodeSheetOpen}
                onOpenChange={setNodeSheetOpen}
                form={nodeForm}
                setForm={setNodeForm}
                nodeOptions={nodeOptions}
                disabled={disabled}
                onSave={() => void handleSaveNode()}
            />

            <EdgeFormSheet
                open={edgeSheetOpen}
                onOpenChange={setEdgeSheetOpen}
                form={edgeForm}
                setForm={setEdgeForm}
                nodeOptions={nodeOptions}
                disabled={disabled}
                onSave={() => void handleSaveEdge()}
            />

            <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open && !confirmRunning) setConfirm(null) }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
                        <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={confirmRunning}>取消</AlertDialogCancel>
                        <AlertDialogAction
                            className={confirm?.destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
                            disabled={confirmRunning}
                            onClick={(event) => {
                                event.preventDefault()
                                void runConfirm()
                            }}
                        >
                            {confirmRunning ? <Loader2 className="size-4 animate-spin" /> : null}
                            {confirm?.actionLabel}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}

/** 头部摘要行的竖分隔。Separator 的 vertical 变体要靠父级高度，这里父级高度是 auto，直接给固定高度更稳 */
function MetaDivider() {
    return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

function KindDot({ kind }: { kind: SiteGraphNodeKind }) {
    return (
        <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ background: `var(${KIND_COLOR_VAR[kind]})` }}
        />
    )
}

function StatusBadge({ status }: { status: SiteGraphStatus }) {
    const meta = STATUS_META[status]
    return (
        <Badge variant="outline" className={`px-1.5 py-0 text-[11px] font-normal ${meta.className}`}>
            {meta.label}
        </Badge>
    )
}

function LockMark({ locked }: { locked: boolean }) {
    return locked
        ? <Lock className="size-3 text-muted-foreground" aria-label="已锁定" />
        : <LockOpen className="size-3 text-muted-foreground/30" aria-label="未锁定" />
}

function StatTile({ label, value, accent }: { label: string; value: number; accent: string }) {
    return (
        <div className="relative overflow-hidden rounded-xl border bg-card px-3.5 py-3 transition-colors hover:border-foreground/20">
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5" style={{ background: accent, opacity: 0.7 }} />
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: accent }} aria-hidden="true" />
                <span className="truncate">{label}</span>
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums leading-none">{value}</div>
        </div>
    )
}

/** 行内操作：默认淡出，悬停/键盘聚焦时才实体化，表格因此清爽很多 */
function RowActions({
    disabled,
    editLabel,
    deleteLabel,
    onEdit,
    onDelete,
}: {
    disabled: boolean
    editLabel: string
    deleteLabel: string
    onEdit: () => void
    onDelete: () => void
}) {
    return (
        <div className="flex justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={editLabel} title={editLabel} onClick={onEdit}>
                <Pencil />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={deleteLabel}
                title={deleteLabel}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={onDelete}
            >
                <Trash2 />
            </Button>
        </div>
    )
}

function TableSkeleton({ columns }: { columns: number }) {
    return (
        <div className="divide-y">
            {Array.from({ length: 6 }).map((_, row) => (
                <div key={row} className="flex items-center gap-4 px-4 py-3">
                    {Array.from({ length: columns }).map((__, column) => (
                        <Skeleton key={column} className={`h-4 ${column === 0 ? "w-48" : "flex-1"}`} />
                    ))}
                </div>
            ))}
        </div>
    )
}

function PanelShell({
    title,
    description,
    action,
    children,
}: {
    title: string
    description: string
    action?: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <section className="flex flex-col rounded-xl border bg-card">
            <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
                </div>
                {action}
            </header>
            <div className="flex-1 p-4">{children}</div>
        </section>
    )
}

function ValidationPanel({
    validation,
    loading,
}: {
    validation: SiteGraphValidationReport | null
    loading: boolean
}) {
    const counts = React.useMemo(() => {
        const issues = validation?.issues ?? []
        return {
            error: issues.filter((issue) => issue.severity === "error").length,
            warning: issues.filter((issue) => issue.severity === "warning").length,
            info: issues.filter((issue) => issue.severity === "info").length,
        }
    }, [validation])

    return (
        <PanelShell
            title="校验报告"
            description="存在错误项时禁止发布。生成后自动校验一次，人工改动后可点「重新校验」。"
        >
            {loading ? (
                <div className="space-y-3">
                    <Skeleton className="h-16 w-full rounded-lg" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                </div>
            ) : !validation ? (
                <p className="text-sm text-muted-foreground">尚无校验记录。</p>
            ) : (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3">
                        <div>
                            <div className="text-[11px] text-muted-foreground">评分</div>
                            <div
                                className={`text-3xl font-semibold tabular-nums leading-none ${
                                    validation.passed ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                                }`}
                            >
                                {validation.score}
                            </div>
                        </div>
                        <span aria-hidden="true" className="h-10 w-px shrink-0 bg-border" />
                        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
                            <MetaPair stacked label="节点" value={validation.nodeCount} />
                            <MetaPair stacked label="关系" value={validation.edgeCount} />
                            <MetaPair stacked label="孤立节点" value={validation.orphanCount} />
                            <MetaPair stacked label="最大层级" value={validation.maxDepth} />
                        </dl>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <IssueCount label="错误" count={counts.error} className="text-destructive" dot="bg-destructive" />
                        <IssueCount label="警告" count={counts.warning} className="text-amber-600 dark:text-amber-400" dot="bg-amber-500" />
                        <IssueCount label="提示" count={counts.info} className="text-muted-foreground" dot="bg-muted-foreground/50" />
                        <span className="ml-auto text-muted-foreground">校验于 {formatDateTime(validation.checkedAt)}</span>
                    </div>

                    {validation.issues.length === 0 ? (
                        <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="size-4" />
                            没有发现问题。
                        </p>
                    ) : (
                        <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
                            {validation.issues.map((issue, index) => (
                                <IssueRow key={`${issue.code}-${issue.target}-${index}`} issue={issue} />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </PanelShell>
    )
}

function RunPanel({ run, loading }: { run: SiteGraphRunSummary | null; loading: boolean }) {
    return (
        <PanelShell
            title="最近一次生成"
            description="抽取 Agent 的运行记录。"
            action={run ? (
                <Badge variant="outline" className={`shrink-0 ${RUN_STATUS_META[run.status].className}`}>
                    {RUN_STATUS_META[run.status].label}
                </Badge>
            ) : undefined}
        >
            {loading ? (
                <div className="space-y-2">
                    {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-4 w-full" />)}
                </div>
            ) : !run ? (
                <Empty className="border-0 p-0 md:p-0">
                    <EmptyHeader>
                        <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
                        <EmptyTitle>尚未运行过抽取 Agent</EmptyTitle>
                        <EmptyDescription>点右上角「Agent 生成」从公开文章抽取节点与关系。</EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <div className="space-y-3 text-sm">
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                        <MetaPair label="模式" value={run.mode === "FULL" ? "全量" : "增量"} />
                        <MetaPair label="模型" value={run.modelName ?? "—"} />
                        <MetaPair label="文章数" value={run.articleCount} />
                        <MetaPair label="节点 / 关系" value={`${run.nodeCount} / ${run.edgeCount}`} />
                        <MetaPair label="开始时间" value={formatDateTime(run.startedAt)} />
                        <MetaPair label="结束时间" value={formatDateTime(run.finishedAt)} />
                    </dl>
                    {run.errorMessage ? (
                        <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                            {run.errorMessage}
                        </p>
                    ) : null}
                    {run.warnings.length > 0 ? (
                        <ul className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                            {run.warnings.map((warning) => (
                                <li key={warning} className="flex items-start gap-2">
                                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                                    <span className="min-w-0">{warning}</span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            )}
        </PanelShell>
    )
}

/** stacked 用于宽栏里的指标条：横排 label/value 在宽格子里会被拉开老远，不如上下叠 */
function MetaPair({ label, value, stacked }: { label: string; value: React.ReactNode; stacked?: boolean }) {
    if (stacked) {
        return (
            <div className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{value}</dd>
            </div>
        )
    }
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right font-medium tabular-nums">{value}</dd>
        </div>
    )
}

function IssueCount({ label, count, className, dot }: { label: string; count: number; className: string; dot: string }) {
    return (
        <span className={`inline-flex items-center gap-1.5 ${count === 0 ? "text-muted-foreground/50" : className}`}>
            <span className={`size-1.5 rounded-full ${count === 0 ? "bg-muted-foreground/30" : dot}`} aria-hidden="true" />
            {label} {count}
        </span>
    )
}

function IssueRow({ issue }: { issue: SiteGraphIssue }) {
    const meta = SEVERITY_META[issue.severity]
    return (
        <li className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50">
            <span className={`mt-[0.4rem] size-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
            <span className="min-w-0">
                <span className={`text-xs font-medium ${meta.className}`}>{meta.label}</span>
                <span className="mx-1.5 font-mono text-[11px] text-muted-foreground">{issue.target}</span>
                <span className="text-muted-foreground">{issue.message}</span>
            </span>
        </li>
    )
}

/** 表单区块标题，把长表单切成几段，比一整片输入框好扫 */
function FormSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section className="space-y-3">
            <div className="flex items-baseline gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
                {hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}
            </div>
            {children}
        </section>
    )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            {children}
        </div>
    )
}

function NodeFormSheet({
    open,
    onOpenChange,
    form,
    setForm,
    nodeOptions,
    disabled,
    onSave,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    form: NodeFormState
    setForm: React.Dispatch<React.SetStateAction<NodeFormState>>
    nodeOptions: SiteGraphOverviewResponse["nodeOptions"]
    disabled: boolean
    onSave: () => void
}) {
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
                <SheetHeader className="border-b">
                    <SheetTitle>{form.id ? "编辑节点" : "新增节点"}</SheetTitle>
                    <SheetDescription>
                        节点键留空时按「类型-名称」自动生成。手工保存的节点会标记为人工维护，Agent 重跑不会覆盖；
                        勾选「锁定」后连属性也不会被覆盖。
                    </SheetDescription>
                </SheetHeader>

                <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
                    <FormSection title="基本信息">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="节点名称">
                                <Input
                                    value={form.name}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                    placeholder="向量检索"
                                />
                            </Field>
                            <Field label="节点类型">
                                <Select
                                    value={form.kind}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, kind: value as SiteGraphNodeKind }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {NODE_KIND_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                                <KindDot kind={option.value} />
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </div>
                        <Field label="摘要（前台悬停展示）">
                            <Textarea
                                value={form.summary}
                                disabled={disabled}
                                rows={3}
                                onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))}
                            />
                        </Field>
                    </FormSection>

                    <FormSection title="定位" hint="邻接表层级与站内链接">
                        <Field label="父节点">
                            <Select
                                value={form.parentId}
                                disabled={disabled}
                                onValueChange={(value) => setForm((current) => ({ ...current, parentId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NONE_PARENT}>（无父节点）</SelectItem>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            <KindDot kind={option.kind} />
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="节点键（可空）">
                                <Input
                                    value={form.nodeKey}
                                    disabled={disabled}
                                    className="font-mono text-xs"
                                    onChange={(event) => setForm((current) => ({ ...current, nodeKey: event.target.value }))}
                                    placeholder="concept-向量检索"
                                />
                            </Field>
                            <Field label="站内链接（须以 / 开头）">
                                <Input
                                    value={form.route}
                                    disabled={disabled}
                                    className="font-mono text-xs"
                                    onChange={(event) => setForm((current) => ({ ...current, route: event.target.value }))}
                                    placeholder="/p/abcd1234"
                                />
                            </Field>
                        </div>
                    </FormSection>

                    <FormSection title="属性与别名" hint="属性每行一条，格式 名称=值">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="节点属性">
                                <Textarea
                                    value={form.attributesText}
                                    disabled={disabled}
                                    rows={4}
                                    className="font-mono text-xs"
                                    onChange={(event) => setForm((current) => ({ ...current, attributesText: event.target.value }))}
                                    placeholder={"类别=检索技术\n典型场景=RAG 问答"}
                                />
                            </Field>
                            <Field label="别名（逗号分隔）">
                                <Textarea
                                    value={form.aliasesText}
                                    disabled={disabled}
                                    rows={4}
                                    onChange={(event) => setForm((current) => ({ ...current, aliasesText: event.target.value }))}
                                    placeholder="vector search, 向量搜索"
                                />
                            </Field>
                        </div>
                    </FormSection>

                    <FormSection title="发布控制">
                        <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="权重（影响点半径）">
                                <Input
                                    type="number"
                                    value={form.weight}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, weight: event.target.value }))}
                                />
                            </Field>
                            <Field label="置信度">
                                <Input
                                    type="number"
                                    value={form.confidence}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, confidence: event.target.value }))}
                                />
                            </Field>
                            <Field label="状态">
                                <Select
                                    value={form.status}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, status: value as SiteGraphStatus }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {STATUS_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </div>
                        <ToggleRow
                            id="node-locked"
                            label="锁定"
                            hint="Agent 重跑时不覆盖该节点的属性"
                            checked={form.locked}
                            disabled={disabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, locked: checked }))}
                        />
                    </FormSection>
                </div>

                <SheetFooter className="flex-row justify-end gap-2 border-t">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={disabled}>
                        取消
                    </Button>
                    <Button type="button" onClick={onSave} disabled={disabled}>
                        {disabled ? <Loader2 className="animate-spin" /> : <Plus />}
                        {form.id ? "保存修改" : "新增节点"}
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    )
}

function EdgeFormSheet({
    open,
    onOpenChange,
    form,
    setForm,
    nodeOptions,
    disabled,
    onSave,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    form: EdgeFormState
    setForm: React.Dispatch<React.SetStateAction<EdgeFormState>>
    nodeOptions: SiteGraphOverviewResponse["nodeOptions"]
    disabled: boolean
    onSave: () => void
}) {
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
                <SheetHeader className="border-b">
                    <SheetTitle>{form.id ? "编辑关系" : "新增关系"}</SheetTitle>
                    <SheetDescription>
                        关系用于连接不同分支的节点；父子层级请在节点表单里用「父节点」维护。
                    </SheetDescription>
                </SheetHeader>

                <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
                    <FormSection title="连接">
                        <Field label="起点">
                            <Select
                                value={form.fromNodeId}
                                disabled={disabled}
                                onValueChange={(value) => setForm((current) => ({ ...current, fromNodeId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue placeholder="选择起点节点" /></SelectTrigger>
                                <SelectContent>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            <KindDot kind={option.kind} />
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field label="关系名称">
                            <Input
                                value={form.relation}
                                disabled={disabled}
                                onChange={(event) => setForm((current) => ({ ...current, relation: event.target.value }))}
                                placeholder="阐述"
                            />
                        </Field>
                        <Field label="终点">
                            <Select
                                value={form.toNodeId}
                                disabled={disabled}
                                onValueChange={(value) => setForm((current) => ({ ...current, toNodeId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue placeholder="选择终点节点" /></SelectTrigger>
                                <SelectContent>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            <KindDot kind={option.kind} />
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    </FormSection>

                    <FormSection title="属性" hint="每行一条，格式 名称=值">
                        <Textarea
                            value={form.attributesText}
                            disabled={disabled}
                            rows={3}
                            className="font-mono text-xs"
                            onChange={(event) => setForm((current) => ({ ...current, attributesText: event.target.value }))}
                            placeholder="依据=文中第 2 节"
                        />
                    </FormSection>

                    <FormSection title="发布控制">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="关系类型">
                                <Select
                                    value={form.kind}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, kind: value as SiteGraphEdgeKind }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {EDGE_KIND_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field label="状态">
                                <Select
                                    value={form.status}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, status: value as SiteGraphStatus }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {STATUS_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field label="权重">
                                <Input
                                    type="number"
                                    value={form.weight}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, weight: event.target.value }))}
                                />
                            </Field>
                            <Field label="置信度">
                                <Input
                                    type="number"
                                    value={form.confidence}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, confidence: event.target.value }))}
                                />
                            </Field>
                        </div>
                        <ToggleRow
                            id="edge-directed"
                            label="有向关系"
                            hint="关闭后视为双向，前台不画箭头"
                            checked={form.directed}
                            disabled={disabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, directed: checked }))}
                        />
                        <ToggleRow
                            id="edge-locked"
                            label="锁定"
                            hint="Agent 重跑时不覆盖该关系"
                            checked={form.locked}
                            disabled={disabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, locked: checked }))}
                        />
                    </FormSection>
                </div>

                <SheetFooter className="flex-row justify-end gap-2 border-t">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={disabled}>
                        取消
                    </Button>
                    <Button type="button" onClick={onSave} disabled={disabled}>
                        {disabled ? <Loader2 className="animate-spin" /> : <Plus />}
                        {form.id ? "保存修改" : "新增关系"}
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    )
}

function ToggleRow({
    id,
    label,
    hint,
    checked,
    disabled,
    onCheckedChange,
}: {
    id: string
    label: string
    hint: string
    checked: boolean
    disabled: boolean
    onCheckedChange: (checked: boolean) => void
}) {
    return (
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5">
            <div className="min-w-0">
                <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        </div>
    )
}
