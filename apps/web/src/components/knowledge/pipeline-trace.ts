"use client"

/**
 * 处理流水线时间线的纯计算部分：把 span 树摊平成甘特图的行，
 * 算出每行在时间轴上的位置，并统计头部要显示的汇总数字。
 */

import type { KBSpanNode, KBSpanStatus } from "@/lib/api"

/** 主流程阶段的中文名。子任务名是自由文本，直接原样显示。 */
export const STAGE_LABEL: Record<string, string> = {
  extract: "文档解析",
  chunking: "分块",
  embedding: "向量化",
  multimodal: "多模态识别",
  postprocess: "后处理",
  wiki: "Wiki 构建",
}

export const STATUS_LABEL: Record<KBSpanStatus, string> = {
  pending: "等待中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
}

export const ROOT_LABEL = "知识处理"

/** 时间线上的一行。 */
export interface TraceRow {
  node: KBSpanNode
  depth: number
  label: string
  /** 该行在时间轴上的起点占比（0-1）。 */
  offsetRatio: number
  /** 该行的时长占比（0-1）。 */
  widthRatio: number
  hasChildren: boolean
  /** 时长未知（还没结束或没记开始时间）时为 true，条形以虚线呈现。 */
  indeterminate: boolean
}

export interface TraceWindow {
  start: number
  end: number
  totalMs: number
}

export interface PostprocessSummary {
  running: number
  failed: number
  completed: number
  total: number
}

function timestamp(value?: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function nodeStart(node: KBSpanNode): number | null {
  return timestamp(node.startedAt)
}

function nodeEnd(node: KBSpanNode): number | null {
  const finished = timestamp(node.finishedAt)
  if (finished !== null) return finished
  const started = nodeStart(node)
  if (started !== null && node.durationMs > 0) return started + node.durationMs
  return null
}

/** 遍历整棵树，得到时间轴的起止。没有任何时间戳时返回 null。 */
export function computeTraceWindow(root: KBSpanNode | null | undefined, now = Date.now()): TraceWindow | null {
  if (!root) return null
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  let seen = false

  const walk = (node: KBSpanNode) => {
    const nodeStartedAt = nodeStart(node)
    if (nodeStartedAt !== null) {
      seen = true
      start = Math.min(start, nodeStartedAt)
      // 还在跑的行用「现在」当作右端，条形才会随时间生长。
      const finishedAt = nodeEnd(node) ?? (node.status === "running" ? now : nodeStartedAt)
      end = Math.max(end, finishedAt)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)

  if (!seen) return null
  if (end <= start) end = start + 1
  return { start, end, totalMs: end - start }
}

/**
 * 把 span 树摊平成可渲染的行。collapsed 里的 spanId 其子树不展开。
 */
export function flattenTrace(
  root: KBSpanNode | null | undefined,
  collapsed: ReadonlySet<string>,
  window: TraceWindow | null,
  now = Date.now()
): TraceRow[] {
  if (!root) return []
  const rows: TraceRow[] = []

  const walk = (node: KBSpanNode, depth: number) => {
    const children = node.children ?? []
    const startedAt = nodeStart(node)
    const finishedAt = nodeEnd(node) ?? (node.status === "running" && startedAt !== null ? now : null)

    let offsetRatio = 0
    let widthRatio = 0
    let indeterminate = true
    if (window && startedAt !== null) {
      offsetRatio = clampRatio((startedAt - window.start) / window.totalMs)
      if (finishedAt !== null) {
        widthRatio = clampRatio((finishedAt - startedAt) / window.totalMs)
        indeterminate = false
      }
    }

    rows.push({
      node,
      depth,
      label: spanLabel(node),
      offsetRatio,
      widthRatio,
      hasChildren: children.length > 0,
      indeterminate,
    })

    if (children.length > 0 && !collapsed.has(node.spanId)) {
      for (const child of children) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(value, 1)
}

/** root 与主流程阶段显示中文名，子任务保留原始 span 名（如 multimodal.page[3]）。 */
export function spanLabel(node: KBSpanNode): string {
  if (node.kind === "root") return ROOT_LABEL
  if (node.kind === "stage") return STAGE_LABEL[node.name] ?? node.name
  return node.name
}

/** 主流程阶段已完成的数量，用于头部的「主流程阶段 n/5」。 */
export function countFinishedStages(root: KBSpanNode | null | undefined): { done: number; total: number } {
  const stages = (root?.children ?? []).filter((child) => child.kind === "stage")
  const done = stages.filter((stage) =>
    stage.status === "done" || stage.status === "skipped" || stage.status === "failed" || stage.status === "cancelled"
  ).length
  return { done, total: stages.length }
}

/**
 * 统计后处理与 Wiki 阶段的叶子任务，用于头部的「后台任务：运行中 x / 失败 y / 已完成 z」。
 * 只数叶子，父节点的状态是聚合出来的，重复计入会让数字虚高。
 */
export function summarizePostprocess(root: KBSpanNode | null | undefined): PostprocessSummary {
  const summary: PostprocessSummary = { running: 0, failed: 0, completed: 0, total: 0 }
  const backgroundStages = (root?.children ?? []).filter((child) => child.name === "postprocess" || child.name === "wiki")
  if (backgroundStages.length === 0) return summary

  const countLeaves = (node: KBSpanNode) => {
    const children = node.children ?? []
    if (children.length > 0) {
      children.forEach(countLeaves)
      return
    }
    summary.total += 1
    if (node.status === "running" || node.status === "pending") summary.running += 1
    else if (node.status === "failed") summary.failed += 1
    else summary.completed += 1
  }
  for (const stage of backgroundStages) {
    const children = stage.children ?? []
    if (children.length > 0) children.forEach(countLeaves)
    else if (stage.name === "wiki" && !stage.placeholder) countLeaves(stage)
  }
  return summary
}

/** 把毫秒格式化成 9ms / 4.49s / 1m19.6s，与时间轴刻度保持一致的读法。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(2)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}m${rest.toFixed(1)}s`
}

/** 生成时间轴顶部的刻度：0 起点加若干等分点。 */
export function buildAxisTicks(totalMs: number, count = 4): Array<{ ratio: number; label: string }> {
  const ticks: Array<{ ratio: number; label: string }> = [{ ratio: 0, label: "0ms" }]
  if (!Number.isFinite(totalMs) || totalMs <= 0) return ticks
  for (let index = 1; index <= count; index += 1) {
    const ratio = index / count
    ticks.push({ ratio, label: formatDuration(totalMs * ratio) })
  }
  return ticks
}
