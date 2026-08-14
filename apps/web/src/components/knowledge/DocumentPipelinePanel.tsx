"use client"

/**
 * 处理流水线面板：把一次解析的 span 树画成甘特图。
 *
 * 行按「根 → 主流程阶段 → 子任务」层级缩进，右侧是按同一时间轴对齐的耗时条，
 * 因此哪一段最花时间、哪些子任务真正并行，一眼就能看出来。
 * 文档解析或异步 Wiki 构建进行中时每 2 秒轮询一次，全部结束后自动停。
 */

import * as React from "react"
import { ChevronDown, ChevronRight, Loader2, RefreshCw, X } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  knowledgeBaseDocumentApi,
  type KBDocumentSpansResponse,
  type KBSpanNode,
  type KBSpanStatus,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  buildAxisTicks,
  computeTraceWindow,
  countFinishedStages,
  flattenTrace,
  formatDuration,
  spanLabel,
  STAGE_LABEL,
  STATUS_LABEL,
  summarizePostprocess,
} from "@/components/knowledge/pipeline-trace"

const POLL_INTERVAL_MS = 2000

const KIND_LABEL: Record<string, string> = {
  root: "ROOT",
  stage: "STAGE",
  subspan: "SUBSPAN",
  generation: "GENERATION",
}

const STATUS_DOT: Record<KBSpanStatus, string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-primary animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
  cancelled: "bg-amber-500",
}

const STATUS_BAR: Record<KBSpanStatus, string> = {
  pending: "bg-muted-foreground/25",
  running: "bg-primary/70",
  done: "bg-emerald-500",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/25",
  cancelled: "bg-amber-500/70",
}

function apiError(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : fallback)
  )
}

export interface DocumentPipelinePanelProps {
  /** 传 null 关闭面板。 */
  documentId: string | null
  documentTitle?: string
  onOpenChange: (open: boolean) => void
  /** 解析结束（成功或失败）时回调，用于刷新外层列表。 */
  onFinished?: () => void
  /** 触发重新解析；由外层负责准备页面图片等输入。 */
  onReparse?: () => void
}

export function DocumentPipelinePanel({
  documentId,
  documentTitle,
  onOpenChange,
  onFinished,
  onReparse,
}: DocumentPipelinePanelProps) {
  const [data, setData] = React.useState<KBDocumentSpansResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [selected, setSelected] = React.useState<KBSpanNode | null>(null)
  // 进行中的行要随时间生长，靠这个每秒变化的时钟驱动重绘。
  const [now, setNow] = React.useState(() => Date.now())
  const finishedRef = React.useRef(false)

  const running = data?.status === "pending" || data?.status === "processing" || Boolean(data?.currentStage)

  const load = React.useCallback(
    async (id: string, silent: boolean) => {
      if (!silent) setLoading(true)
      try {
        const response = await knowledgeBaseDocumentApi.documentSpans(id)
        setData(response.data)
        const done = response.data.status !== "pending" && response.data.status !== "processing" && !response.data.currentStage
        if (done && !finishedRef.current) {
          finishedRef.current = true
          onFinished?.()
        }
      } catch (error) {
        if (!silent) toast.error(apiError(error, "加载处理流水线失败"))
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [onFinished]
  )

  React.useEffect(() => {
    if (!documentId) {
      setData(null)
      setSelected(null)
      return
    }
    finishedRef.current = false
    void load(documentId, false)
  }, [documentId, load])

  React.useEffect(() => {
    if (!documentId || !running) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void load(documentId, true)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [documentId, load, running])

  const trace = data?.trace ?? null
  const traceWindow = React.useMemo(() => computeTraceWindow(trace, now), [trace, now])
  const rows = React.useMemo(() => flattenTrace(trace, collapsed, traceWindow, now), [trace, collapsed, traceWindow, now])
  const stages = React.useMemo(() => countFinishedStages(trace), [trace])
  const postprocess = React.useMemo(() => summarizePostprocess(trace), [trace])
  const ticks = React.useMemo(() => buildAxisTicks(traceWindow?.totalMs ?? 0), [traceWindow])

  const toggle = React.useCallback((spanId: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(spanId)) next.delete(spanId)
      else next.add(spanId)
      return next
    })
  }, [])

  return (
    <Sheet open={Boolean(documentId)} onOpenChange={(open) => !open && onOpenChange(false)}>
      <SheetContent side="right" className="w-[96vw] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,92vw)]">
        <SheetHeader className="shrink-0 space-y-2 border-b px-5 py-3 pr-12 text-left">
          <div className="flex items-center gap-2">
            <SheetTitle className="min-w-0 flex-1 truncate text-base">{documentTitle ?? "处理流水线"}</SheetTitle>
            {data ? <StatusBadge status={data.status} /> : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="立即刷新"
              disabled={loading || !documentId}
              onClick={() => documentId && void load(documentId, false)}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </Button>
          </div>
          <SheetDescription className="text-xs">
            处理流水线 · 总耗时 {formatDuration(traceWindow?.totalMs ?? 0)} · 主流程阶段 {stages.done}/{stages.total} ·
            后台任务：运行中 {postprocess.running} / 失败 {postprocess.failed} / 已完成 {postprocess.completed} · 第{" "}
            {data?.attempt ?? 0} 次尝试
          </SheetDescription>
        </SheetHeader>

        {data?.lastError ? (
          <div className="shrink-0 border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">
            <span className="font-medium">{spanNameLabel(data.lastError.stage)} 失败</span>
            {data.lastError.code ? <span className="ml-2 opacity-80">{data.lastError.code}</span> : null}
            <p className="mt-0.5 whitespace-pre-wrap opacity-90">{data.lastError.message}</p>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="app-scrollbar min-w-0 flex-1 overflow-auto">
            <div className="min-w-[720px]">
              <div className="sticky top-0 z-10 flex items-center border-b bg-background/95 px-4 py-2 text-[11px] text-muted-foreground backdrop-blur">
                <span className="w-[300px] shrink-0">阶段</span>
                <span className="w-[96px] shrink-0 text-right">耗时</span>
                <span className="relative ml-4 flex-1">
                  {ticks.map((tick) => (
                    <span
                      key={tick.ratio}
                      className="absolute -translate-x-1/2 whitespace-nowrap font-mono"
                      style={{ left: `${tick.ratio * 100}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </span>
              </div>

              {rows.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {loading ? "正在加载…" : "暂无解析记录"}
                </p>
              ) : (
                rows.map((row) => (
                  <button
                    key={row.node.spanId}
                    type="button"
                    onClick={() => setSelected(row.node)}
                    className={cn(
                      "flex w-full items-center px-4 py-1.5 text-left text-sm transition-colors hover:bg-muted/50",
                      selected?.spanId === row.node.spanId ? "bg-muted" : null
                    )}
                  >
                    <span className="flex w-[300px] shrink-0 items-center gap-1.5" style={{ paddingLeft: row.depth * 16 }}>
                      {row.hasChildren ? (
                        <span
                          role="presentation"
                          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background"
                          onClick={(event) => {
                            event.stopPropagation()
                            toggle(row.node.spanId)
                          }}
                        >
                          {collapsed.has(row.node.spanId) ? (
                            <ChevronRight className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                        </span>
                      ) : (
                        <span className="size-4 shrink-0" />
                      )}
                      <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[row.node.status])} />
                      <span className={cn("truncate", row.node.kind === "root" ? "font-semibold" : null)}>{row.label}</span>
                    </span>
                    <span className="w-[70px] shrink-0 text-right font-mono text-[10px] uppercase text-muted-foreground">
                      {KIND_LABEL[row.node.kind] ?? row.node.kind}
                    </span>
                    <span className="w-[96px] shrink-0 text-right font-mono text-xs tabular-nums">
                      {row.indeterminate ? STATUS_LABEL[row.node.status] : formatDuration(row.node.durationMs)}
                    </span>
                    <span className="relative ml-4 h-3 flex-1">
                      {/* 时长未知的行画成从起点铺到右端的虚线框，避免用实心条暗示一个并不存在的耗时。 */}
                      <span
                        className={cn(
                          "absolute top-1/2 h-2 -translate-y-1/2 rounded-sm",
                          row.indeterminate
                            ? "border border-dashed border-muted-foreground/40"
                            : STATUS_BAR[row.node.status]
                        )}
                        style={{
                          left: `${row.offsetRatio * 100}%`,
                          width: `${Math.max((row.indeterminate ? 1 - row.offsetRatio : row.widthRatio) * 100, 0.6)}%`,
                          minWidth: 2,
                        }}
                      />
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {selected ? (
            <aside className="app-scrollbar hidden w-[300px] shrink-0 overflow-y-auto border-l px-4 py-3 lg:block">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{spanLabel(selected)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {KIND_LABEL[selected.kind] ?? selected.kind} · {STATUS_LABEL[selected.status]}
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label="关闭详情" onClick={() => setSelected(null)}>
                  <X className="size-4" />
                </Button>
              </div>
              <DetailRow label="开始" value={formatTimestamp(selected.startedAt)} />
              <DetailRow label="结束" value={formatTimestamp(selected.finishedAt)} />
              <DetailRow label="耗时" value={selected.durationMs > 0 ? formatDuration(selected.durationMs) : "-"} />
              {selected.errorMessage ? (
                <div className="mt-3 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
                  <p className="font-medium">{selected.errorCode || "失败"}</p>
                  <p className="mt-1 whitespace-pre-wrap">{selected.errorMessage}</p>
                </div>
              ) : null}
              <JsonBlock label="输入" value={selected.input} />
              <JsonBlock label="输出" value={selected.output} />
              {selected.placeholder ? (
                <p className="mt-3 text-xs text-muted-foreground">此阶段没有记录详细 span，仅展示推断状态。</p>
              ) : null}
            </aside>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {running ? "解析进行中，每 2 秒自动刷新一次" : "点击任意一行查看该阶段的入参、出参与错误详情"}
          </p>
          <div className="flex items-center gap-2">
            {onReparse ? (
              <Button variant="outline" size="sm" disabled={running} onClick={onReparse}>
                重新解析
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function spanNameLabel(name: string): string {
  return STAGE_LABEL[name] ?? name
}

function StatusBadge({ status }: { status: KBDocumentSpansResponse["status"] }) {
  const meta = {
    pending: { label: "等待中", className: "text-amber-600 dark:text-amber-400" },
    processing: { label: "处理中", className: "text-primary" },
    partial: { label: "部分完成", className: "text-amber-600 dark:text-amber-400" },
    ready: { label: "已完成", className: "text-emerald-600 dark:text-emerald-400" },
    failed: { label: "失败", className: "text-destructive" },
  }[status]
  return (
    <Badge variant="outline" className={cn("shrink-0 font-normal", meta.className)}>
      {meta.label}
    </Badge>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono">{value}</span>
    </div>
  )
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="app-scrollbar mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function formatTimestamp(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const seconds = String(date.getSeconds()).padStart(2, "0")
  return `${hours}:${minutes}:${seconds}.${String(date.getMilliseconds()).padStart(3, "0")}`
}

export default DocumentPipelinePanel
