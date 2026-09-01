"use client"

import * as React from "react"

import { GraphRetrievalMiniMap, type MiniMapLink, type MiniMapNode } from "@/components/site-graph/GraphRetrievalMiniMap"

/**
 * 星图检索链路的展示组件，前台问答与后台助手共用。
 *
 * 配色变量与 /graph 页图例同源（--site-graph-*），保证「问答里看到的节点颜色」
 * 和「星图页看到的」是一套。用语义色令牌而非写死的白色透明度，
 * 这样在前台（retypeset 暗色）与后台（shadcn 暗色）两种外壳里都成立。
 */

const FALLBACK_GRAPH_KIND_META = { label: "概念", colorVar: "--site-graph-concept" }

const GRAPH_KIND_META: Record<string, { label: string; colorVar: string }> = {
    root: { label: "站点", colorVar: "--site-graph-root" },
    section: { label: "分类", colorVar: "--site-graph-section" },
    article: { label: "文章", colorVar: "--site-graph-article" },
    concept: { label: "概念", colorVar: "--site-graph-concept" },
    entity: { label: "实体", colorVar: "--site-graph-entity" },
    tag: { label: "标签", colorVar: "--site-graph-tag" },
}

export interface GraphChainNode {
    id: string
    label: string
    kind: string
}

export function GraphNodeChip({ label, kind }: { label: string; kind: string }) {
    const meta = GRAPH_KIND_META[kind] ?? FALLBACK_GRAPH_KIND_META
    return (
        <span
            className="inline-flex max-w-[12rem] items-center gap-1 rounded-md border border-foreground/15 bg-foreground/5 px-1.5 py-0.5"
            title={`${meta.label}：${label}`}
        >
            <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: `var(${meta.colorVar})` }}
                aria-hidden="true"
            />
            <span className="truncate text-[11px] text-foreground/90">{label}</span>
        </span>
    )
}

/** 一条链路：节点与关系交替渲染，形如 A --阐述--> B --依赖--> C */
export function GraphPathChain({
    nodes,
    relations,
}: {
    nodes: GraphChainNode[]
    relations: string[]
}) {
    return (
        <div className="flex flex-wrap items-center gap-1">
            {nodes.map((node, index) => (
                <React.Fragment key={`${node.id}-${index}`}>
                    {index > 0 ? (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                            <span aria-hidden="true">→</span>
                            {relations[index - 1] ? <span>{relations[index - 1]}</span> : null}
                            <span aria-hidden="true">→</span>
                        </span>
                    ) : null}
                    <GraphNodeChip label={node.label} kind={node.kind} />
                </React.Fragment>
            ))}
        </div>
    )
}

/** 卡片主体：命中概念 + 关联链路。前台问答与后台助手共用同一份，观感一致 */
export function GraphRetrievalBody({
    matched,
    paths,
    graphNodes,
    graphLinks,
    onNavigate,
    maxPaths = 5,
}: {
    matched: GraphChainNode[]
    paths: Array<{ nodes: GraphChainNode[]; relations: string[] }>
    /** 子图节点与关系；给出时在顶部渲染与 /graph 同款的点群 */
    graphNodes?: MiniMapNode[]
    graphLinks?: MiniMapLink[]
    onNavigate?: (route: string) => void
    maxPaths?: number
}) {
    return (
        <div className="space-y-3">
            {graphNodes && graphNodes.length > 1 ? (
                <GraphRetrievalMiniMap
                    nodes={graphNodes}
                    links={graphLinks ?? []}
                    onNavigate={onNavigate}
                />
            ) : null}

            {matched.length > 0 ? (
                <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">命中概念</p>
                    <div className="flex flex-wrap gap-1">
                        {matched.slice(0, 8).map((node, index) => (
                            <GraphNodeChip key={`${node.id}-${index}`} label={node.label} kind={node.kind} />
                        ))}
                    </div>
                </div>
            ) : null}

            {paths.length > 0 ? (
                <div>
                    <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        关联链路（{paths.length}）
                    </p>
                    <div className="space-y-2">
                        {paths.slice(0, maxPaths).map((path, index) => (
                            <div key={index} className="rounded-md border border-foreground/10 bg-foreground/5 px-2.5 py-2">
                                <GraphPathChain nodes={path.nodes} relations={path.relations} />
                            </div>
                        ))}
                    </div>
                    {paths.length > maxPaths ? (
                        <p className="mt-1.5 text-[10px] text-muted-foreground">
                            另有 {paths.length - maxPaths} 条链路未展开
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

/**
 * 从工具返回体里解析出可渲染的链路与命中节点。
 * 两个宿主的 render 都拿到的是 unknown，解析逻辑放这里避免各写一遍。
 */
export function parseGraphRetrievalResult(result: unknown) {
    const payload = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null

    const toRecords = (value: unknown) => Array.isArray(value)
        ? value.flatMap((item) =>
            item && typeof item === "object" && !Array.isArray(item) ? [item as Record<string, unknown>] : [])
        : []

    const matched: GraphChainNode[] = toRecords(payload?.matched).map((node) => ({
        id: String(node.id ?? ""),
        label: String(node.label ?? ""),
        kind: String(node.kind ?? "concept"),
    }))

    const paths = toRecords(payload?.paths).flatMap((path) => {
        const nodes = toRecords(path.nodes).map((node) => ({
            id: String(node.id ?? ""),
            label: String(node.label ?? ""),
            kind: String(node.kind ?? "concept"),
        }))
        if (nodes.length < 2) return []
        const relations = Array.isArray(path.relations) ? path.relations.map((item) => String(item)) : []
        return [{ nodes, relations }]
    })

    const graphNodes: MiniMapNode[] = toRecords(payload?.nodes).map((node) => ({
        id: String(node.id ?? ""),
        label: String(node.label ?? ""),
        kind: String(node.kind ?? "concept"),
        route: typeof node.route === "string" ? node.route : null,
    }))

    const graphLinks: MiniMapLink[] = toRecords(payload?.links).map((link) => ({
        source: String(link.source ?? ""),
        target: String(link.target ?? ""),
        relation: String(link.relation ?? ""),
        kind: String(link.kind ?? "reference"),
    }))

    return {
        matched,
        paths,
        graphNodes,
        graphLinks,
        emptyMessage: typeof payload?.emptyMessage === "string" ? payload.emptyMessage : "",
    }
}
