"use client"

import * as React from "react"
import { Brain, Clock, Database, Info, Loader2, MessageSquarePlus, RefreshCw, Sparkles, Trash2 } from "lucide-react"
import { Label, Pie, PieChart } from "recharts"
import { toast } from "sonner"

import {
  agentMemoryApi,
  type AgentMemoryItem,
  type AgentMemoryKind,
  type AgentMemoryListResponse,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import {
  TableBody,
  TableCell,
  TableColumnHeader,
  TableHead,
  TableHeader,
  TableHeaderGroup,
  TableProvider,
  TableRow,
  type ColumnDef,
} from "@/components/kibo-ui/table"

const KIND_META: Record<AgentMemoryKind, { label: string; description: string; color: string }> = {
  PREFERENCE: { label: "偏好", description: "你对回答方式的要求（语言、详略、格式、引用等）", color: "var(--chart-1)" },
  TOPIC: { label: "常关注", description: "你反复关注或正在深入的主题、领域、项目", color: "var(--chart-2)" },
  FACT: { label: "背景", description: "你的稳定背景与正在推进的目标 / 决定 / 技术栈", color: "var(--chart-3)" },
}

const KIND_ORDER: AgentMemoryKind[] = ["PREFERENCE", "TOPIC", "FACT"]

// 与 MAX_ACTIVE_MEMORIES / REFLECT_TRIGGER_ACTIVE_COUNT 对齐（服务端 agent-memory-logic）
const MEMORY_CAP = 30
const REFLECT_THRESHOLD = 24

const chartConfig: ChartConfig = {
  count: { label: "记忆" },
  PREFERENCE: { label: "偏好", color: "var(--chart-1)" },
  TOPIC: { label: "常关注", color: "var(--chart-2)" },
  FACT: { label: "背景", color: "var(--chart-3)" },
}

export function AgentMemoryPage() {
  const [data, setData] = React.useState<AgentMemoryListResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [observing, setObserving] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await agentMemoryApi.list()
      setData(res.data)
    } catch {
      toast.error("记忆加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleObserve = async () => {
    setObserving(true)
    try {
      const res = await agentMemoryApi.distill()
      const { status, created, merged, sampledQuestions } = res.data
      if (status === "distilled") {
        toast.success(`已从 ${sampledQuestions} 条对话中观察：新增 ${created} 条、强化 ${merged} 条`)
      } else if (status === "no_new_messages") {
        toast.info("没有新的对话可供观察，先去文档问答里聊几轮吧")
      } else if (status === "nothing_to_keep") {
        toast.info(`分析了 ${sampledQuestions} 条对话，暂时没有值得长期记住的内容`)
      }
      await load()
    } catch (error) {
      toast.error(resolveErrorMessage(error, "观察失败，请检查默认模型配置"))
    } finally {
      setObserving(false)
    }
  }

  const handleDelete = React.useCallback(async (memory: AgentMemoryItem) => {
    if (!window.confirm(`确认删除这条记忆？删除后 Agent 将立即忘记它。\n\n${memory.content}`)) return
    setDeletingId(memory.id)
    try {
      await agentMemoryApi.delete(memory.id)
      toast.success("已删除")
      await load()
    } catch {
      toast.error("删除失败")
    } finally {
      setDeletingId(null)
    }
  }, [load])

  const items = React.useMemo(() => data?.items ?? [], [data])
  const state = data?.state ?? null

  const chartData = React.useMemo(
    () =>
      KIND_ORDER
        .map((kind) => ({
          kind,
          label: KIND_META[kind].label,
          count: items.filter((item) => item.kind === kind).length,
          fill: KIND_META[kind].color,
        }))
        .filter((entry) => entry.count > 0),
    [items],
  )

  const columns = React.useMemo<ColumnDef<AgentMemoryItem>[]>(() => [
    {
      accessorKey: "content",
      enableSorting: false,
      header: () => <span className="text-xs font-medium text-muted-foreground">记忆内容</span>,
      cell: ({ row }) => (
        <span className="block max-w-xl text-sm leading-relaxed">{row.original.content}</span>
      ),
    },
    {
      accessorKey: "kind",
      header: ({ column }) => <TableColumnHeader column={column} title="类型" />,
      cell: ({ row }) => <KindBadge kind={row.original.kind} />,
    },
    {
      accessorKey: "evidenceCount",
      header: ({ column }) => <TableColumnHeader column={column} title="被观察" />,
      cell: ({ row }) => (
        <span className="tabular-nums text-sm">{row.original.evidenceCount} 次</span>
      ),
    },
    {
      accessorKey: "lastSeenAt",
      header: ({ column }) => <TableColumnHeader column={column} title="最近" />,
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">{formatRelative(row.original.lastSeenAt)}</span>
      ),
    },
    {
      id: "actions",
      enableSorting: false,
      header: () => <span className="sr-only">操作</span>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => void handleDelete(row.original)}
            disabled={deletingId === row.original.id}
            aria-label="删除记忆"
          >
            {deletingId === row.original.id
              ? <Loader2 className="size-4 animate-spin" />
              : <Trash2 className="size-4" />}
          </Button>
        </div>
      ),
    },
  ], [deletingId, handleDelete])

  const capacityPct = Math.min(100, Math.round((items.length / MEMORY_CAP) * 100))

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Brain className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Agent 记忆</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              文档问答 Agent 会像人一样观察你的历史对话（提问 + 回答），维护一份长期观察记忆并注入后续问答，让回答更懂你；
              记忆变多时会自动重构压缩。全部可见、可删，删除立即生效。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 size-4" />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => void handleObserve()} disabled={observing}>
            {observing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
            {observing ? "观察中…" : "立即观察"}
          </Button>
        </div>
      </div>

      {loading ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
          </div>
          <Skeleton className="h-72 w-full rounded-xl" />
        </>
      ) : (
        <>
          {/* KPI 概览条 */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile
              icon={<Brain className="size-4" />}
              label="记忆总数"
              value={String(items.length)}
              hint={`上限 ${MEMORY_CAP} 条`}
            />
            <StatTile
              icon={<MessageSquarePlus className="size-4" />}
              label="待观察的新消息"
              value={String(state?.pendingMessageCount ?? 0)}
              hint="下次观察会读取"
            />
            <StatTile
              icon={<Clock className="size-4" />}
              label="上次观察"
              value={state?.lastDistilledAt ? formatRelative(state.lastDistilledAt) : "尚未观察"}
              hint={state && state.distillCount > 0 ? `累计 ${state.distillCount} 次` : "每 12 小时最多一次"}
            />
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database className="size-4" />
                记忆容量
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {items.length}
                <span className="text-sm font-normal text-muted-foreground"> / {MEMORY_CAP}</span>
              </div>
              <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${capacityPct}%` }} />
                {/* 反思触发阈值标记 */}
                <div
                  className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-amber-500"
                  style={{ left: `${(REFLECT_THRESHOLD / MEMORY_CAP) * 100}%` }}
                />
              </div>
              <div className="mt-1.5 text-[11px] leading-tight text-muted-foreground">
                超过 {REFLECT_THRESHOLD} 条触发反思压缩
              </div>
            </div>
          </div>

          {items.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                <div className="flex size-12 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground">
                  <Brain className="size-5" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium">还没有记忆</div>
                  <div className="max-w-md text-xs leading-relaxed text-muted-foreground">
                    在文档问答里多聊几轮后，观察器（Observer）会自动记录（每 12 小时最多一次、需累积 5 条以上新消息）；
                    也可以点右上角「立即观察」马上试一次。
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
              {/* 记忆构成：环形图 */}
              <Card className="lg:col-span-1">
                <CardHeader className="pb-0">
                  <CardTitle className="text-base">记忆构成</CardTitle>
                  <CardDescription>按类型分布</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-center gap-3">
                  <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-[190px] w-full">
                    <PieChart>
                      <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="label" hideLabel />} />
                      <Pie data={chartData} dataKey="count" nameKey="label" innerRadius={54} outerRadius={84} strokeWidth={4} paddingAngle={2}>
                        <Label content={({ viewBox }) => {
                          if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                            const cx = viewBox.cx ?? 0
                            const cy = viewBox.cy ?? 0
                            return (
                              <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                                <tspan x={cx} y={cy} className="fill-foreground text-2xl font-semibold">{items.length}</tspan>
                                <tspan x={cx} y={cy + 20} className="fill-muted-foreground text-xs">条记忆</tspan>
                              </text>
                            )
                          }
                          return null
                        }} />
                      </Pie>
                    </PieChart>
                  </ChartContainer>
                  <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 pb-1">
                    {chartData.map((entry) => (
                      <span key={entry.kind} className="flex items-center gap-1.5 text-xs">
                        <span className="size-2.5 rounded-full" style={{ backgroundColor: entry.fill }} />
                        {entry.label}
                        <span className="tabular-nums text-muted-foreground">{entry.count}</span>
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* 记忆明细：表格 */}
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    记忆明细
                    <Badge variant="secondary" className="font-normal">{items.length}</Badge>
                  </CardTitle>
                  <CardDescription>点列头可按类型 / 被观察次数 / 时间排序；删除后立即生效。</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto border-t">
                    <TableProvider columns={columns} data={items}>
                      <TableHeader>
                        {({ headerGroup }) => (
                          <TableHeaderGroup headerGroup={headerGroup} key={headerGroup.id}>
                            {({ header }) => <TableHead header={header} key={header.id} />}
                          </TableHeaderGroup>
                        )}
                      </TableHeader>
                      <TableBody>
                        {({ row }) => (
                          <TableRow key={row.id} row={row}>
                            {({ cell }) => <TableCell cell={cell} key={cell.id} />}
                          </TableRow>
                        )}
                      </TableBody>
                    </TableProvider>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              记忆按「被观察次数 + 新近度」排序，问答时最多注入前 10 条，仅作背景参考——与当前问题冲突时
              Agent 会忽略。相似表述会自动合并（配置向量模型后按语义合并）；当活跃记忆超过 {REFLECT_THRESHOLD} 条时，
              反思器（Reflector）会重构压缩整份日志，硬上限 {MEMORY_CAP} 条。
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function StatTile({ icon, label, value, hint }: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function KindBadge({ kind }: { kind: AgentMemoryKind }) {
  const meta = KIND_META[kind]
  return (
    <Badge variant="secondary" className="gap-1.5 font-normal whitespace-nowrap">
      <span className="size-2 rounded-full" style={{ backgroundColor: meta.color }} />
      {meta.label}
    </Badge>
  )
}

function formatRelative(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diffMs = Date.now() - date.getTime()
  const hours = Math.floor(diffMs / 3_600_000)
  if (hours < 1) return "刚刚"
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return date.toLocaleDateString()
}

function resolveErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    if (typeof response?.data?.msg === "string" && response.data.msg) {
      return response.data.msg
    }
  }
  return fallback
}
