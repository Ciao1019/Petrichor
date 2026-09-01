"use client"

import {
  AlertTriangle,
  Info
} from "@/components/iconimate"
import * as React from "react"

import {
  type SiteGraphAdminEdge,
  type SiteGraphAdminNode,
  type SiteGraphAttribute,
  type SiteGraphEdgeKind,
  type SiteGraphNodeKind,
  type SiteGraphRunSummary,
  type SiteGraphSource,
  type SiteGraphStatus
} from "@/lib/api"


export const NODE_KIND_OPTIONS: { value: SiteGraphNodeKind; label: string }[] = [
    { value: "root", label: "站点根" },
    { value: "section", label: "分类" },
    { value: "article", label: "文章" },
    { value: "concept", label: "概念" },
    { value: "entity", label: "实体" },
    { value: "tag", label: "标签" },
]

export const EDGE_KIND_OPTIONS: { value: SiteGraphEdgeKind; label: string }[] = [
    { value: "reference", label: "引用" },
    { value: "semantic", label: "语义关联" },
    { value: "derived", label: "衍生" },
]

export const STATUS_OPTIONS: { value: SiteGraphStatus; label: string }[] = [
    { value: "DRAFT", label: "草稿" },
    { value: "PUBLISHED", label: "已发布" },
    { value: "ARCHIVED", label: "已归档" },
]

export const KIND_LABEL: Record<SiteGraphNodeKind, string> = {
    root: "站点根",
    section: "分类",
    article: "文章",
    concept: "概念",
    entity: "实体",
    tag: "标签",
}

/** 与前台 /graph 共用同一套点群配色（定义在 app/site-graph.css），后台的类型点因此和星图对得上 */
export const KIND_COLOR_VAR: Record<SiteGraphNodeKind, string> = {
    root: "--site-graph-root",
    section: "--site-graph-section",
    article: "--site-graph-article",
    concept: "--site-graph-concept",
    entity: "--site-graph-entity",
    tag: "--site-graph-tag",
}

export const STATUS_META: Record<SiteGraphStatus, { label: string; className: string }> = {
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

export const SOURCE_LABEL: Record<SiteGraphSource, string> = {
    AGENT: "Agent",
    MANUAL: "人工",
    SYSTEM: "系统",
}

export const RUN_STATUS_META: Record<SiteGraphRunSummary["status"], { label: string; className: string }> = {
    RUNNING: { label: "运行中", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    COMPLETED: { label: "已完成", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    FAILED: { label: "失败", className: "border-destructive/30 bg-destructive/10 text-destructive" },
}

export const SEVERITY_META = {
    error: { label: "错误", icon: AlertTriangle, className: "text-destructive", dot: "bg-destructive" },
    warning: { label: "警告", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
    info: { label: "提示", icon: Info, className: "text-muted-foreground", dot: "bg-muted-foreground/50" },
} as const

export interface NodeFormState {
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

export interface EdgeFormState {
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
export interface ConfirmState {
    title: string
    description: React.ReactNode
    actionLabel: string
    destructive?: boolean
    run: () => Promise<void>
}

export const NONE_PARENT = "__none__"
export const ALL_FILTER = "__all__"

export function emptyNodeForm(): NodeFormState {
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

export function emptyEdgeForm(): EdgeFormState {
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
export function attributesToText(attributes: SiteGraphAttribute[]) {
    return attributes.map((attribute) => `${attribute.name}=${attribute.value}`).join("\n")
}

export function parseAttributesText(text: string): SiteGraphAttribute[] {
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

export function parseListText(text: string) {
    return text
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
}

export function toNodeForm(node: SiteGraphAdminNode): NodeFormState {
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

export function toEdgeForm(edge: SiteGraphAdminEdge): EdgeFormState {
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

export function resolveApiError(error: unknown, fallback: string) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        fallback
    )
}

export function toPositiveInt(value: string, fallback: number) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

export function formatDateTime(value?: string | null) {
    if (!value) return "—"
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
