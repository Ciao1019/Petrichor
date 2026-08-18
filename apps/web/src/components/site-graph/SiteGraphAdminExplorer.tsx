"use client"

import * as React from "react"
import { ExternalLink, Lock, LockOpen, Maximize2, Pencil, Search } from "@/components/iconimate"

import { createSiteGraphRuntime, type SiteGraphRuntime } from "@/components/site-graph/graph-runtime"
import type {
    SiteGraphAdminEdge,
    SiteGraphAdminNode,
    SiteGraphNodeKind,
    SiteGraphPayload,
    SiteGraphPayloadLink,
    SiteGraphPayloadNode,
    SiteGraphStatus,
} from "@/lib/api"

/**
 * 后台版点群图谱：和前台 /graph 用同一套力导运行时与配色，
 * 区别在数据源与交互——这里吃的是后台总览的全量节点（含草稿/归档），
 * 选中节点后给的是「状态 / 来源 / 锁定 / 属性」这类后台信息，并能直接跳去编辑。
 */

const KIND_LABEL: Record<SiteGraphNodeKind, string> = {
    root: "站点根",
    section: "分类",
    article: "文章",
    concept: "概念",
    entity: "实体",
    tag: "标签",
}

const KIND_COLOR_VAR: Record<SiteGraphNodeKind, string> = {
    root: "--site-graph-root",
    section: "--site-graph-section",
    article: "--site-graph-article",
    concept: "--site-graph-concept",
    entity: "--site-graph-entity",
    tag: "--site-graph-tag",
}

const LEGEND_KINDS: SiteGraphNodeKind[] = ["section", "article", "concept", "entity", "tag"]

const STATUS_META: Record<SiteGraphStatus, { label: string; className: string }> = {
    PUBLISHED: { label: "已发布", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    DRAFT: { label: "草稿", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    ARCHIVED: { label: "已归档", className: "border-border bg-muted text-muted-foreground" },
}

const SOURCE_LABEL = { AGENT: "Agent", MANUAL: "人工", SYSTEM: "系统" } as const

export type SiteGraphScope = "all" | "published"

/**
 * 后台节点/关系 → 运行时载荷。
 * 与服务端 public-graph 的差别：这里用数据库 id 当节点 id（后台本来就按 id 索引），
 * 且不做「文章可达性」裁剪——后台要看到的正是包括游离点在内的真实全貌。
 */
export function buildAdminGraphPayload(
    nodes: SiteGraphAdminNode[],
    edges: SiteGraphAdminEdge[],
    scope: SiteGraphScope,
): SiteGraphPayload {
    const visibleNodes = scope === "published"
        ? nodes.filter((node) => node.status === "PUBLISHED")
        : nodes
    const visibleIds = new Set(visibleNodes.map((node) => node.id))

    const payloadNodes: SiteGraphPayloadNode[] = visibleNodes.map((node) => ({
        id: node.id,
        label: node.name,
        kind: node.kind,
        route: node.route,
        summary: node.summary,
        attributes: node.attributes,
        aliases: node.aliases,
        // 父节点被过滤掉时降级为顶层节点，否则结构边会指向不存在的点
        parentId: node.parentId && visibleIds.has(node.parentId) ? node.parentId : null,
        topSectionId: null,
        weight: node.weight,
    }))

    const links: SiteGraphPayloadLink[] = []
    for (const node of payloadNodes) {
        if (node.parentId) {
            links.push({ source: node.parentId, target: node.id, kind: "structure", relation: "包含" })
        }
    }
    for (const edge of edges) {
        if (scope === "published" && edge.status !== "PUBLISHED") continue
        if (!visibleIds.has(edge.fromNodeId) || !visibleIds.has(edge.toNodeId)) continue
        if (edge.fromNodeId === edge.toNodeId) continue
        links.push({ source: edge.fromNodeId, target: edge.toNodeId, kind: edge.kind, relation: edge.relation })
    }

    return {
        nodes: payloadNodes,
        links,
        stats: {
            nodeCount: payloadNodes.length,
            linkCount: links.length,
            articleCount: payloadNodes.filter((node) => node.kind === "article").length,
            conceptCount: payloadNodes.filter((node) => node.kind === "concept" || node.kind === "entity").length,
        },
        generatedAt: null,
    }
}

export function SiteGraphAdminExplorer({
    nodes,
    edges,
    scope,
    onScopeChange,
    onEditNode,
    className,
}: {
    nodes: SiteGraphAdminNode[]
    edges: SiteGraphAdminEdge[]
    scope: SiteGraphScope
    onScopeChange: (scope: SiteGraphScope) => void
    onEditNode?: (node: SiteGraphAdminNode) => void
    className?: string
}) {
    const stageRef = React.useRef<HTMLDivElement | null>(null)
    const mountRef = React.useRef<HTMLDivElement | null>(null)
    const runtimeRef = React.useRef<SiteGraphRuntime | null>(null)

    const [hoverId, setHoverId] = React.useState<string | null>(null)
    const [selectedId, setSelectedId] = React.useState<string | null>(null)
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [keyword, setKeyword] = React.useState("")

    const adminNodeById = React.useMemo(
        () => new Map(nodes.map((node) => [node.id, node])),
        [nodes],
    )

    const payload = React.useMemo(
        () => buildAdminGraphPayload(nodes, edges, scope),
        [edges, nodes, scope],
    )

    // 运行时重建代价不小（要重新起力导），只在数据真正变化时重建，
    // 而不是每次父组件重渲染都拆一遍
    const payloadKey = React.useMemo(
        () => `${scope}|${payload.nodes.map((node) => node.id).join(",")}|${payload.links.length}`,
        [payload, scope],
    )

    React.useEffect(() => {
        const stage = stageRef.current
        const mount = mountRef.current
        if (!stage || !mount || payload.nodes.length === 0) {
            setStatus("ready")
            return
        }

        let disposed = false
        let runtime: SiteGraphRuntime | null = null
        const refitTimers: number[] = []
        setStatus("loading")

        void createSiteGraphRuntime({
            stage,
            mount,
            payload,
            onHoverNode: (node) => setHoverId(node?.id ?? null),
            onSelectNode: (node) => setSelectedId(node?.id ?? null),
            onNavigate: (route) => window.open(route, "_blank", "noopener,noreferrer"),
        })
            .then((created) => {
                if (disposed) {
                    created.dispose()
                    return
                }
                runtime = created
                runtimeRef.current = created
                created.start()
                setStatus("ready")
                /* 运行时只在构造时取景一次，之后力导仍在低能量下继续动。
                   后台会展示游离节点（没有结构边，只受斥力），它们会持续飘远，
                   初始视野很快就框不住整图——等布局稳下来后再补两次取景。 */
                refitTimers.push(
                    window.setTimeout(() => created.fit(), 500),
                    window.setTimeout(() => created.fit(), 1600),
                )
            })
            .catch((error: unknown) => {
                console.error("后台星图初始化失败", error)
                if (!disposed) setStatus("error")
            })

        const handleResize = () => runtime?.resize()
        window.addEventListener("resize", handleResize)
        // 首帧容器可能还没完成布局，靠 ResizeObserver 在尺寸稳定后再量一次
        const sizeObserver = new ResizeObserver(() => runtime?.resize())
        sizeObserver.observe(stage)
        // 后台可自由切换明暗，主题变了要重新取色
        const themeObserver = new MutationObserver(() => runtime?.updateTheme())
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

        return () => {
            disposed = true
            for (const timer of refitTimers) window.clearTimeout(timer)
            window.removeEventListener("resize", handleResize)
            sizeObserver.disconnect()
            themeObserver.disconnect()
            runtime?.dispose()
            runtimeRef.current = null
        }
        // payloadKey 已概括数据变化
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [payloadKey])

    const matches = React.useMemo(() => {
        const query = keyword.trim().toLowerCase()
        if (!query) return []
        return payload.nodes
            .filter((node) =>
                node.label.toLowerCase().includes(query)
                || node.summary.toLowerCase().includes(query)
                || node.aliases.some((alias) => alias.toLowerCase().includes(query)))
            .slice(0, 8)
    }, [keyword, payload.nodes])

    const focusNode = React.useCallback((nodeId: string) => {
        runtimeRef.current?.focusAndCenter(nodeId)
        setSelectedId(nodeId)
        setKeyword("")
    }, [])

    const detailNode = adminNodeById.get(hoverId ?? selectedId ?? "") ?? null

    return (
        <div className={`flex flex-col gap-3 ${className ?? ""}`}>
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={keyword}
                        onChange={(event) => setKeyword(event.target.value)}
                        placeholder="搜索节点，回车定位"
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && matches[0]) focusNode(matches[0].id)
                            if (event.key === "Escape") setKeyword("")
                        }}
                        className="h-9 w-full rounded-md border bg-transparent px-3 pl-8 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                    />
                    {matches.length > 0 ? (
                        <ul className="absolute left-0 right-0 top-10 z-20 overflow-hidden rounded-md border bg-popover p-1 shadow-md">
                            {matches.map((node) => (
                                <li key={node.id}>
                                    <button
                                        type="button"
                                        onMouseEnter={() => runtimeRef.current?.setPreviewNode(node.id)}
                                        onMouseLeave={() => runtimeRef.current?.setPreviewNode(null)}
                                        onClick={() => focusNode(node.id)}
                                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                                    >
                                        <KindDot kind={node.kind} />
                                        <span className="truncate">{node.label}</span>
                                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                                            {KIND_LABEL[node.kind]}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>

                {/* 范围切换：默认看全量（含草稿），切到「仅已发布」就是前台 /graph 的实际效果 */}
                <div className="inline-flex h-9 items-center rounded-lg bg-muted p-[3px] text-sm">
                    <ScopeButton active={scope === "all"} onClick={() => onScopeChange("all")}>全部</ScopeButton>
                    <ScopeButton active={scope === "published"} onClick={() => onScopeChange("published")}>仅已发布</ScopeButton>
                </div>

                <button
                    type="button"
                    onClick={() => runtimeRef.current?.fit()}
                    title="重新取景，把整张图收进视野"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50"
                >
                    <Maximize2 className="size-4" />
                    重新取景
                </button>

                <span className="ml-auto text-xs text-muted-foreground">
                    {payload.stats.nodeCount} 个节点 · {payload.stats.linkCount} 条连线
                </span>
            </div>

            <div className="relative h-[30rem] overflow-hidden rounded-xl border bg-card xl:h-[36rem]">
                {payload.nodes.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                        <p className="text-sm font-medium">
                            {scope === "published" ? "还没有已发布的节点" : "还没有节点"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {scope === "published"
                                ? "发布后这里会显示前台 /graph 的实际效果。"
                                : "点「Agent 生成」从公开文章抽取，或手动新增一个节点。"}
                        </p>
                    </div>
                ) : (
                    <>
                        <div ref={stageRef} className="site-graph-stage">
                            <div ref={mountRef} className="site-graph-mount" />
                        </div>

                        {status !== "ready" ? (
                            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                                {status === "loading" ? "正在加载星图…" : "星图加载失败，请刷新页面重试"}
                            </div>
                        ) : null}

                        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5 text-[11px]">
                            {LEGEND_KINDS.map((kind) => (
                                <span
                                    key={kind}
                                    className="inline-flex items-center gap-1 rounded-full border bg-background/80 px-2 py-0.5 text-muted-foreground backdrop-blur-sm"
                                >
                                    <KindDot kind={kind} />
                                    {KIND_LABEL[kind]}
                                </span>
                            ))}
                        </div>

                        <p className="pointer-events-none absolute bottom-3 left-3 rounded-full border bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                            滚轮缩放 · 拖拽平移 · 拖动节点 · 单击查看详情 · 双击打开页面
                        </p>

                        {detailNode ? (
                            <NodeDetailCard node={detailNode} onEdit={onEditNode} />
                        ) : null}
                    </>
                )}
            </div>
        </div>
    )
}

function ScopeButton({
    active,
    onClick,
    children,
}: {
    active: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex h-full items-center rounded-md px-2.5 text-sm font-medium transition-colors ${
                active
                    ? "bg-background text-foreground shadow-sm dark:bg-input/30"
                    : "text-muted-foreground hover:text-foreground"
            }`}
        >
            {children}
        </button>
    )
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

function NodeDetailCard({
    node,
    onEdit,
}: {
    node: SiteGraphAdminNode
    onEdit?: (node: SiteGraphAdminNode) => void
}) {
    const statusMeta = STATUS_META[node.status]
    return (
        <div className="absolute bottom-3 right-3 w-72 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-1.5">
                <KindDot kind={node.kind} />
                <span className="text-[11px] text-muted-foreground">{KIND_LABEL[node.kind]}</span>
                <span className={`ml-auto rounded-full border px-1.5 py-0.5 text-[10px] ${statusMeta.className}`}>
                    {statusMeta.label}
                </span>
                {node.locked
                    ? <Lock className="size-3 text-muted-foreground" aria-label="已锁定" />
                    : <LockOpen className="size-3 text-muted-foreground/30" aria-label="未锁定" />}
            </div>

            <p className="mt-1 text-sm font-semibold leading-snug">{node.name}</p>
            <p className="truncate font-mono text-[10px] text-muted-foreground">{node.nodeKey}</p>

            {node.summary ? (
                <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{node.summary}</p>
            ) : null}

            {node.attributes.length > 0 ? (
                <dl className="mt-2 space-y-0.5 text-[11px]">
                    {node.attributes.slice(0, 4).map((attribute) => (
                        <div key={attribute.name} className="flex gap-2">
                            <dt className="shrink-0 text-muted-foreground">{attribute.name}</dt>
                            <dd className="min-w-0 flex-1 truncate text-right">{attribute.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}

            <dl className="mt-2 grid grid-cols-3 gap-1 border-t pt-2 text-[10px] text-muted-foreground">
                <MiniStat label="子节点" value={node.childCount} />
                <MiniStat label="关系" value={node.degree} />
                <MiniStat label="置信" value={node.confidence} />
            </dl>

            <div className="mt-2 flex gap-1.5">
                {onEdit ? (
                    <button
                        type="button"
                        onClick={() => onEdit(node)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
                    >
                        <Pencil className="size-3" />
                        编辑
                    </button>
                ) : null}
                {node.route ? (
                    <a
                        href={node.route}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
                    >
                        <ExternalLink className="size-3" />
                        打开页面
                    </a>
                ) : null}
            </div>
        </div>
    )
}

function MiniStat({ label, value }: { label: string; value: number }) {
    return (
        <div className="min-w-0">
            <dt>{label}</dt>
            <dd className="text-xs font-medium tabular-nums text-foreground">{value}</dd>
        </div>
    )
}
