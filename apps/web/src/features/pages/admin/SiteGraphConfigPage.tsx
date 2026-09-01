"use client"

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
  Merge,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  X
} from "@/components/iconimate"
import * as React from "react"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  adminSiteGraphApi,
  type SiteGraphAdminEdge,
  type SiteGraphAdminNode,
  type SiteGraphMergeCandidate,
  type SiteGraphOverviewResponse
} from "@/lib/api"
import {
  EdgeFormSheet,
  KindDot,
  LockMark,
  MetaDivider,
  NodeFormSheet,
  RowActions,
  RunPanel,
  StatTile,
  StatusBadge,
  TableSkeleton,
  ValidationPanel,
} from "./SiteGraphConfigPanels"
import { SiteGraphNodeTable } from "./SiteGraphNodeTable"
import {
  ALL_FILTER,
  EDGE_KIND_OPTIONS,
  NODE_KIND_OPTIONS,
  NONE_PARENT,
  SOURCE_LABEL,
  emptyEdgeForm,
  emptyNodeForm,
  formatDateTime,
  parseAttributesText,
  parseListText,
  resolveApiError,
  toEdgeForm,
  toNodeForm,
  toPositiveInt,
  type ConfirmState,
  type EdgeFormState,
  type NodeFormState
} from "./site-graph-config-utils"

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
                    <SiteGraphNodeTable
                        disabled={disabled}
                        loading={loading && !overview}
                        nodes={filteredNodes}
                        total={overview?.nodes.length ?? 0}
                        filterActive={nodeFilterActive}
                        keyword={nodeKeyword}
                        kindFilter={nodeKindFilter}
                        statusFilter={nodeStatusFilter}
                        onKeywordChange={setNodeKeyword}
                        onKindFilterChange={setNodeKindFilter}
                        onStatusFilterChange={setNodeStatusFilter}
                        onClearFilters={() => {
                            setNodeKeyword("")
                            setNodeKindFilter(ALL_FILTER)
                            setNodeStatusFilter(ALL_FILTER)
                        }}
                        onEdit={openNodeSheet}
                        onRequestDelete={(node) => setConfirm({
                            title: `删除节点「${node.name}」？`,
                            description: "该节点的关系会一并删除，其子节点将变为无父节点。",
                            actionLabel: "确认删除",
                            destructive: true,
                            run: () => handleDeleteNode(node),
                        })}
                    />
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
