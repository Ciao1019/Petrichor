"use client"

import * as React from "react"
import { PanelLeftClose } from "@/components/iconimate"

import { createSiteGraphRuntime, type SiteGraphRuntime } from "@/components/site-graph/graph-runtime"
import { useIsMobile } from "@/hooks/use-mobile"
import { gsap } from "@/lib/gsap"
import type { SiteGraphPayload, SiteGraphPayloadNode } from "@/lib/api"

const KIND_LABEL: Record<SiteGraphPayloadNode["kind"], string> = {
    root: "站点",
    section: "分类",
    article: "文章",
    concept: "概念",
    entity: "实体",
    tag: "标签",
}

const KIND_COLOR_VAR: Record<SiteGraphPayloadNode["kind"], string> = {
    root: "--site-graph-root",
    section: "--site-graph-section",
    article: "--site-graph-article",
    concept: "--site-graph-concept",
    entity: "--site-graph-entity",
    tag: "--site-graph-tag",
}

/** 图例里出现的类型顺序 */
const LEGEND_KINDS: SiteGraphPayloadNode["kind"][] = ["section", "article", "concept", "entity", "tag"]

/** 目录栏展开宽度（rem）。GSAP 补间与内层固定宽度都读它，避免两处写死不一致 */
const TREE_PANEL_WIDTH_REM = 14

export interface SiteGraphExplorerProps {
    payload: SiteGraphPayload
    onNavigate: (route: string) => void
    className?: string
}

/**
 * 点群图谱交互外壳：左侧层级树 + 右侧 Canvas 点群 + 悬停/选中详情。
 * 力导与绘制全部在 graph-runtime 里，本组件只负责 React 侧状态与 DOM 容器。
 */
export function SiteGraphExplorer({ payload, onNavigate, className }: SiteGraphExplorerProps) {
    const stageRef = React.useRef<HTMLDivElement | null>(null)
    const mountRef = React.useRef<HTMLDivElement | null>(null)
    const runtimeRef = React.useRef<SiteGraphRuntime | null>(null)
    const navigateRef = React.useRef(onNavigate)
    // 用 ref 传给运行时：运行时只在 payload 变化时重建，
    // 直接闭包捕获 setTreeOpen 会让它拿到过期的引用
    const collapseTreeRef = React.useRef<() => void>(() => {})

    const [hoverNode, setHoverNode] = React.useState<SiteGraphPayloadNode | null>(null)
    const [selectedNode, setSelectedNode] = React.useState<SiteGraphPayloadNode | null>(null)
    const [keyword, setKeyword] = React.useState("")
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    // 收起侧栏把整幅宽度让给点群；尺寸变化由 ResizeObserver 自动重新取景。
    // 桌面默认展开、手机默认收起，与后台助手页一致。
    const isMobile = useIsMobile()
    const [treeOpen, setTreeOpen] = React.useState(() =>
        typeof window !== "undefined" ? window.innerWidth >= 768 : true,
    )

    navigateRef.current = onNavigate
    // 点击图谱即收起目录；已收起时不重复触发状态更新
    collapseTreeRef.current = () => setTreeOpen((open) => (open ? false : open))

    const nodeById = React.useMemo(
        () => new Map(payload.nodes.map((node) => [node.id, node])),
        [payload.nodes],
    )

    /** 按父子关系分组，供左侧树渲染 */
    const childrenByParent = React.useMemo(() => {
        const map = new Map<string, SiteGraphPayloadNode[]>()
        for (const node of payload.nodes) {
            if (!node.parentId) continue
            map.set(node.parentId, [...(map.get(node.parentId) ?? []), node])
        }
        for (const list of map.values()) {
            list.sort((left, right) => {
                if (left.kind !== right.kind) return left.kind === "section" ? -1 : 1
                return left.label.localeCompare(right.label, "zh-Hans-CN")
            })
        }
        return map
    }, [payload.nodes])

    const rootNodes = React.useMemo(
        () => payload.nodes.filter((node) => !node.parentId || !nodeById.has(node.parentId)),
        [nodeById, payload.nodes],
    )

    const matchedNodes = React.useMemo(() => {
        const query = keyword.trim().toLowerCase()
        if (!query) return null
        return payload.nodes
            .filter((node) =>
                node.label.toLowerCase().includes(query)
                || node.summary.toLowerCase().includes(query)
                || node.attributes.some((attribute) => attribute.value.toLowerCase().includes(query)))
            .slice(0, 40)
    }, [keyword, payload.nodes])

    React.useEffect(() => {
        const stage = stageRef.current
        const mount = mountRef.current
        if (!stage || !mount) return

        let disposed = false
        let runtime: SiteGraphRuntime | null = null

        void createSiteGraphRuntime({
            stage,
            mount,
            payload,
            onHoverNode: setHoverNode,
            onSelectNode: setSelectedNode,
            onCanvasClick: () => collapseTreeRef.current(),
            onNavigate: (route) => navigateRef.current(route),
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
            })
            .catch((error: unknown) => {
                console.error("星图初始化失败", error)
                if (!disposed) setStatus("error")
            })

        const handleResize = () => runtime?.resize()
        window.addEventListener("resize", handleResize)

        // 首帧构造时容器可能还没完成布局，靠 ResizeObserver 在尺寸稳定后再量一次
        const sizeObserver = new ResizeObserver(() => runtime?.resize())
        sizeObserver.observe(stage)

        // 主题切换后重新取色，避免暗色模式下点群仍是亮色
        const themeObserver = new MutationObserver(() => runtime?.updateTheme())
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

        return () => {
            disposed = true
            window.removeEventListener("resize", handleResize)
            sizeObserver.disconnect()
            themeObserver.disconnect()
            runtime?.dispose()
            runtimeRef.current = null
        }
    }, [payload])

    // 侧栏收放动画：与后台助手页同一套参数（GSAP 宽度补间 0.42s / power2.inOut）。
    // 首帧用 gsap.set 直接落位，避免进场时先播一次展开动画。
    const asideRef = React.useRef<HTMLElement | null>(null)
    const asideMountedRef = React.useRef(false)
    const graphPanelRef = React.useRef<HTMLDivElement | null>(null)

    /**
     * 收起状态下点击图谱以外的任何地方即展开。
     * 监听 click 而非 pointerdown：画布的收起动作在 pointerup 触发，
     * 用 pointerdown 会在同一次交互里先展开再收起，看起来像闪一下。
     * treeOpen 走 ref 读取，避免每次开合都重挂监听。
     */
    const treeOpenRef = React.useRef(treeOpen)
    treeOpenRef.current = treeOpen
    React.useEffect(() => {
        const handleDocumentClick = (event: MouseEvent) => {
            if (treeOpenRef.current) return
            const target = event.target
            if (target instanceof Node && graphPanelRef.current?.contains(target)) return
            setTreeOpen(true)
        }
        document.addEventListener("click", handleDocumentClick)
        return () => document.removeEventListener("click", handleDocumentClick)
    }, [])
    React.useLayoutEffect(() => {
        const el = asideRef.current
        if (isMobile) {
            // 从桌面切到手机时清掉 GSAP 写下的行内宽度，否则会盖住 w-full
            asideMountedRef.current = false
            if (el) gsap.set(el, { clearProps: "width" })
            return
        }
        if (!el) return
        const targetWidth = treeOpen ? `${TREE_PANEL_WIDTH_REM}rem` : "0px"
        if (!asideMountedRef.current) {
            asideMountedRef.current = true
            gsap.set(el, { width: targetWidth })
            return
        }
        const tween = gsap.to(el, {
            width: targetWidth,
            duration: 0.42,
            ease: "power2.inOut",
            overwrite: "auto",
        })
        return () => {
            tween.kill()
        }
    }, [treeOpen, isMobile])

    const focusNode = React.useCallback((nodeId: string) => {
        runtimeRef.current?.focusAndCenter(nodeId)
    }, [])

    const previewNode = React.useCallback((nodeId: string | null) => {
        runtimeRef.current?.setPreviewNode(nodeId)
    }, [])

    const detailNode = hoverNode ?? selectedNode

    return (
        <div className={`flex min-h-0 flex-1 flex-col gap-3 lg:flex-row ${className ?? ""}`}>
            {/* 收起时不卸载，只把宽度补间到 0，否则动画无从发生。
                overflow-hidden + 内层固定宽度，保证收起过程中内容被裁切而不是被挤压重排。 */}
            <aside
                ref={asideRef}
                aria-hidden={!treeOpen}
                className={`shrink-0 overflow-hidden will-change-[width] ${
                    treeOpen ? "w-full" : "hidden lg:block"
                }`}
            >
            {/* 面板样式挂在内层：外层只当裁切容器，宽度补间到 0 时不会残留一道描边竖线 */}
            <div
                className="site-graph-panel flex h-full w-full flex-col gap-2 rounded-xl p-3"
                style={{ width: isMobile ? undefined : `${TREE_PANEL_WIDTH_REM}rem` }}
            >
                <div className="flex items-center gap-1">
                    <input
                        value={keyword}
                        onChange={(event) => setKeyword(event.target.value)}
                        placeholder="搜索节点 / 属性"
                        className="min-w-0 flex-1 rounded-md border border-foreground/10 bg-background/40 px-2.5 py-1.5 text-sm outline-none backdrop-blur-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <button
                        type="button"
                        onClick={() => setTreeOpen(false)}
                        title="收起目录"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <PanelLeftClose className="size-3.5" />
                        <span className="sr-only">收起目录</span>
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 text-sm">
                    {matchedNodes ? (
                        matchedNodes.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-muted-foreground">没有匹配的节点</p>
                        ) : (
                            <ul className="space-y-0.5">
                                {matchedNodes.map((node) => (
                                    <li key={node.id}>
                                        <GraphTreeButton
                                            node={node}
                                            active={selectedNode?.id === node.id}
                                            onFocus={focusNode}
                                            onPreview={previewNode}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )
                    ) : (
                        <GraphTree
                            nodes={rootNodes}
                            childrenByParent={childrenByParent}
                            depth={0}
                            selectedId={selectedNode?.id ?? null}
                            onFocus={focusNode}
                            onPreview={previewNode}
                        />
                    )}
                </div>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-1 border-t border-foreground/10 pt-2 text-[11px] text-muted-foreground">
                    <dt>节点</dt>
                    <dd className="text-right text-foreground">{payload.stats.nodeCount}</dd>
                    <dt>关系</dt>
                    <dd className="text-right text-foreground">{payload.stats.linkCount}</dd>
                    <dt>文章</dt>
                    <dd className="text-right text-foreground">{payload.stats.articleCount}</dd>
                    <dt>概念</dt>
                    <dd className="text-right text-foreground">{payload.stats.conceptCount}</dd>
                </dl>
            </div>
            </aside>

            <div ref={graphPanelRef} className="site-graph-panel relative min-h-[24rem] flex-1 overflow-hidden rounded-xl">
                <div ref={stageRef} className="site-graph-stage">
                    <div ref={mountRef} className="site-graph-mount" />
                </div>

                {status !== "ready" ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                        {status === "loading" ? "正在加载星图…" : "星图加载失败，请刷新页面重试"}
                    </div>
                ) : null}

                {/* 展开由「点击图谱以外的区域」触发，不再放浮动按钮 */}

                <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2 text-[11px]">
                    {LEGEND_KINDS.map((kind) => (
                        <span
                            key={kind}
                            className="site-graph-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground"
                        >
                            <span
                                className="size-2 rounded-full"
                                style={{ background: `var(${KIND_COLOR_VAR[kind]})` }}
                                aria-hidden="true"
                            />
                            {KIND_LABEL[kind]}
                        </span>
                    ))}
                </div>

                <p className="site-graph-chip pointer-events-none absolute bottom-3 left-3 rounded-full px-2.5 py-1 text-[11px] text-muted-foreground">
                    滚轮缩放 · 拖拽平移 · 拖动节点 · 单击查看详情 · 双击进入页面
                </p>

                {detailNode ? (
                    <NodeDetailCard
                        node={detailNode}
                        onNavigate={onNavigate}
                    />
                ) : null}
            </div>
        </div>
    )
}

function GraphTree({
    nodes,
    childrenByParent,
    depth,
    selectedId,
    onFocus,
    onPreview,
}: {
    nodes: SiteGraphPayloadNode[]
    childrenByParent: Map<string, SiteGraphPayloadNode[]>
    depth: number
    selectedId: string | null
    onFocus: (nodeId: string) => void
    onPreview: (nodeId: string | null) => void
}) {
    // 只默认展开前两层，深层节点点开才渲染，避免大图谱一次挂上千个 DOM
    return (
        <ul className={depth === 0 ? "space-y-0.5" : "ml-3 space-y-0.5 border-l pl-2"}>
            {nodes.map((node) => (
                <GraphTreeItem
                    key={node.id}
                    node={node}
                    childrenByParent={childrenByParent}
                    depth={depth}
                    selectedId={selectedId}
                    onFocus={onFocus}
                    onPreview={onPreview}
                />
            ))}
        </ul>
    )
}

function GraphTreeItem({
    node,
    childrenByParent,
    depth,
    selectedId,
    onFocus,
    onPreview,
}: {
    node: SiteGraphPayloadNode
    childrenByParent: Map<string, SiteGraphPayloadNode[]>
    depth: number
    selectedId: string | null
    onFocus: (nodeId: string) => void
    onPreview: (nodeId: string | null) => void
}) {
    const children = childrenByParent.get(node.id) ?? []
    const [open, setOpen] = React.useState(depth < 1)

    return (
        <li>
            <div className="flex items-center gap-1">
                {children.length > 0 ? (
                    <button
                        type="button"
                        onClick={() => setOpen((value) => !value)}
                        aria-expanded={open}
                        aria-label={open ? "收起" : "展开"}
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    >
                        {open ? "−" : "+"}
                    </button>
                ) : (
                    <span className="inline-block size-4 shrink-0" aria-hidden="true" />
                )}
                <GraphTreeButton
                    node={node}
                    active={selectedId === node.id}
                    onFocus={onFocus}
                    onPreview={onPreview}
                />
            </div>
            {open && children.length > 0 ? (
                <GraphTree
                    nodes={children}
                    childrenByParent={childrenByParent}
                    depth={depth + 1}
                    selectedId={selectedId}
                    onFocus={onFocus}
                    onPreview={onPreview}
                />
            ) : null}
        </li>
    )
}

function GraphTreeButton({
    node,
    active,
    onFocus,
    onPreview,
}: {
    node: SiteGraphPayloadNode
    active: boolean
    onFocus: (nodeId: string) => void
    onPreview: (nodeId: string | null) => void
}) {
    return (
        <button
            type="button"
            onClick={() => onFocus(node.id)}
            onMouseEnter={() => onPreview(node.id)}
            onMouseLeave={() => onPreview(null)}
            onFocus={() => onPreview(node.id)}
            onBlur={() => onPreview(null)}
            title={node.summary || node.label}
            className={`flex min-w-0 flex-1 items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-xs transition-colors ${
                active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
            }`}
        >
            <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: `var(${KIND_COLOR_VAR[node.kind]})` }}
                aria-hidden="true"
            />
            <span className="truncate">{node.label}</span>
        </button>
    )
}

function NodeDetailCard({
    node,
    onNavigate,
}: {
    node: SiteGraphPayloadNode
    onNavigate: (route: string) => void
}) {
    return (
        <div className="site-graph-panel absolute bottom-3 right-3 w-64 rounded-xl p-3">
            <div className="flex items-center gap-1.5">
                <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: `var(${KIND_COLOR_VAR[node.kind]})` }}
                    aria-hidden="true"
                />
                <span className="text-[11px] text-muted-foreground">{KIND_LABEL[node.kind]}</span>
            </div>
            <p className="mt-1 text-sm font-semibold leading-snug">{node.label}</p>
            {node.summary ? (
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{node.summary}</p>
            ) : null}
            {node.attributes.length > 0 ? (
                <dl className="mt-2 space-y-0.5 text-[11px]">
                    {node.attributes.slice(0, 5).map((attribute) => (
                        <div key={attribute.name} className="flex gap-2">
                            <dt className="shrink-0 text-muted-foreground">{attribute.name}</dt>
                            <dd className="min-w-0 flex-1 truncate text-right">{attribute.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            {node.route ? (
                <button
                    type="button"
                    onClick={() => onNavigate(node.route as string)}
                    className="mt-2 w-full rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
                >
                    打开页面
                </button>
            ) : null}
        </div>
    )
}
