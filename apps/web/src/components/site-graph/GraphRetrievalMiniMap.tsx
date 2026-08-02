"use client"

import * as React from "react"

import { createSiteGraphRuntime, type SiteGraphRuntime } from "@/components/site-graph/graph-runtime"
import type { SiteGraphPayload, SiteGraphPayloadNode } from "@/lib/api"

/**
 * 问答卡片里的小型点群：把一次星图检索的子图用 /graph 同一套力导运行时渲染出来，
 * 观感与「全站星图」页一致（同样的 Canvas 绘制、配色变量、悬停与拖拽）。
 *
 * 与整站图谱的差别只在数据：子图节点是平的（没有父子结构边），
 * 因此运行时会自动回退用关系边做布局力（见 graph-runtime 的 layoutLinks）。
 */

export interface MiniMapNode {
    id: string
    label: string
    kind: string
    route?: string | null
}

export interface MiniMapLink {
    source: string
    target: string
    relation: string
    kind: string
}

const NODE_KINDS = new Set(["root", "section", "article", "concept", "entity", "tag"])
const LINK_KINDS = new Set(["structure", "reference", "semantic", "derived"])

function toNodeKind(kind: string): SiteGraphPayloadNode["kind"] {
    return NODE_KINDS.has(kind) ? kind as SiteGraphPayloadNode["kind"] : "concept"
}

/** 把检索结果补齐成运行时要的载荷形状；缺失字段用中性默认值 */
function buildMiniPayload(nodes: MiniMapNode[], links: MiniMapLink[]): SiteGraphPayload {
    const ids = new Set(nodes.map((node) => node.id))
    const payloadNodes: SiteGraphPayloadNode[] = nodes.map((node) => ({
        id: node.id,
        label: node.label,
        kind: toNodeKind(node.kind),
        route: node.route ?? null,
        summary: "",
        attributes: [],
        aliases: [],
        parentId: null,
        topSectionId: null,
        weight: 1,
    }))
    const payloadLinks = links
        .filter((link) => ids.has(link.source) && ids.has(link.target) && link.source !== link.target)
        .map((link) => ({
            source: link.source,
            target: link.target,
            relation: link.relation,
            kind: (LINK_KINDS.has(link.kind) ? link.kind : "reference") as SiteGraphPayload["links"][number]["kind"],
        }))

    return {
        nodes: payloadNodes,
        links: payloadLinks,
        stats: {
            nodeCount: payloadNodes.length,
            linkCount: payloadLinks.length,
            articleCount: payloadNodes.filter((node) => node.kind === "article").length,
            conceptCount: payloadNodes.filter((node) => node.kind === "concept" || node.kind === "entity").length,
        },
        generatedAt: null,
    }
}

export function GraphRetrievalMiniMap({
    nodes,
    links,
    onNavigate,
    className,
}: {
    nodes: MiniMapNode[]
    links: MiniMapLink[]
    onNavigate?: (route: string) => void
    className?: string
}) {
    const stageRef = React.useRef<HTMLDivElement | null>(null)
    const mountRef = React.useRef<HTMLDivElement | null>(null)
    const navigateRef = React.useRef(onNavigate)
    navigateRef.current = onNavigate

    const [hovered, setHovered] = React.useState<string | null>(null)

    // 只在数据真正变化时重建运行时：卡片会随消息流频繁重渲染
    const payload = React.useMemo(() => buildMiniPayload(nodes, links), [nodes, links])
    const payloadKey = React.useMemo(
        () => `${payload.nodes.map((node) => node.id).join(",")}|${payload.links.length}`,
        [payload],
    )

    React.useEffect(() => {
        const stage = stageRef.current
        const mount = mountRef.current
        if (!stage || !mount || payload.nodes.length === 0) return

        let disposed = false
        let runtime: SiteGraphRuntime | null = null

        void createSiteGraphRuntime({
            stage,
            mount,
            payload,
            onHoverNode: (node) => setHovered(node?.label ?? null),
            onSelectNode: () => {},
            onNavigate: (route) => navigateRef.current?.(route),
        })
            .then((created) => {
                if (disposed) {
                    created.dispose()
                    return
                }
                runtime = created
                created.start()
            })
            .catch((error: unknown) => {
                console.error("检索点群初始化失败", error)
            })

        const observer = new ResizeObserver(() => runtime?.resize())
        observer.observe(stage)
        const onThemeChange = () => runtime?.updateTheme()
        const themeObserver = new MutationObserver(onThemeChange)
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

        return () => {
            disposed = true
            observer.disconnect()
            themeObserver.disconnect()
            runtime?.dispose()
        }
        // payloadKey 已概括数据变化，避免 payload 对象每次新建导致重复重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [payloadKey])

    if (payload.nodes.length === 0) return null

    return (
        <div className={`relative h-56 overflow-hidden rounded-lg border border-foreground/10 bg-foreground/[0.03] ${className ?? ""}`}>
            <div ref={stageRef} className="site-graph-stage">
                <div ref={mountRef} className="site-graph-mount" />
            </div>
            <p className="pointer-events-none absolute bottom-1.5 left-2 text-[10px] text-muted-foreground">
                {hovered ?? "滚轮缩放 · 拖拽平移 · 双击进入页面"}
            </p>
        </div>
    )
}
