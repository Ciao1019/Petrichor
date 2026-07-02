"use client"

import * as React from "react"
import { Brain, Info, Loader2, RefreshCw, Sparkles, Trash2 } from "lucide-react"
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
import { Skeleton } from "@/components/ui/skeleton"

const KIND_META: Record<AgentMemoryKind, { label: string; description: string }> = {
  PREFERENCE: { label: "偏好", description: "你对回答方式的要求（语言、详略、格式、引用等）" },
  TOPIC: { label: "常关注", description: "你在问答中反复关注的主题与领域" },
  FACT: { label: "背景", description: "你透露过的稳定背景（职业、项目、技术栈等）" },
}

const KIND_ORDER: AgentMemoryKind[] = ["PREFERENCE", "TOPIC", "FACT"]

export function AgentMemoryPage() {
  const [data, setData] = React.useState<AgentMemoryListResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [distilling, setDistilling] = React.useState(false)
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

  const handleDistill = async () => {
    setDistilling(true)
    try {
      const res = await agentMemoryApi.distill()
      const { status, created, merged, sampledQuestions } = res.data
      if (status === "distilled") {
        toast.success(`已从 ${sampledQuestions} 条提问中蒸馏：新增 ${created} 条、强化 ${merged} 条`)
      } else if (status === "no_new_messages") {
        toast.info("没有新的提问可供蒸馏，先去文档问答里聊几轮吧")
      } else if (status === "nothing_to_keep") {
        toast.info(`分析了 ${sampledQuestions} 条提问，暂时没有值得长期记住的内容`)
      }
      await load()
    } catch (error) {
      toast.error(resolveErrorMessage(error, "蒸馏失败，请检查默认模型配置"))
    } finally {
      setDistilling(false)
    }
  }

  const handleDelete = async (memory: AgentMemoryItem) => {
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
  }

  const items = data?.items ?? []
  const state = data?.state ?? null
  const grouped = KIND_ORDER
    .map((kind) => ({ kind, memories: items.filter((item) => item.kind === kind) }))
    .filter((group) => group.memories.length > 0)

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
              文档问答 Agent 从你的历史提问中自动蒸馏的长期记忆，会注入后续问答让回答更懂你。
              全部可见、可删，删除立即生效。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 size-4" />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => void handleDistill()} disabled={distilling}>
            {distilling ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
            {distilling ? "蒸馏中…" : "立即蒸馏"}
          </Button>
        </div>
      </div>

      {/* 蒸馏状态 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground">记忆条数</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{loading ? "–" : items.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground">待蒸馏的新提问</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {loading ? "–" : state?.pendingMessageCount ?? 0}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-xs text-muted-foreground">上次蒸馏</div>
          <div className="mt-1 truncate text-sm font-medium">
            {loading ? "–" : state?.lastDistilledAt ? formatDateTime(state.lastDistilledAt) : "尚未蒸馏"}
          </div>
          {state && state.distillCount > 0 ? (
            <div className="mt-0.5 text-xs text-muted-foreground">累计 {state.distillCount} 次</div>
          ) : null}
        </div>
      </div>

      {loading ? (
        <Card>
          <CardContent className="space-y-3 py-6">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      ) : null}

      {!loading && items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground">
              <Brain className="size-5" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium">还没有记忆</div>
              <div className="max-w-md text-xs leading-relaxed text-muted-foreground">
                在文档问答里多聊几轮后，Agent 会自动蒸馏（每 12 小时最多一次、需累积 5 条以上新提问）；
                也可以点右上角「立即蒸馏」马上试一次。
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {grouped.map((group) => {
        const meta = KIND_META[group.kind]
        return (
          <Card key={group.kind}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {meta.label}
                <Badge variant="secondary" className="font-normal">{group.memories.length}</Badge>
              </CardTitle>
              <CardDescription>{meta.description}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y border-t">
                {group.memories.map((memory) => (
                  <div key={memory.id} className="flex items-start justify-between gap-3 px-6 py-3">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm leading-relaxed">{memory.content}</div>
                      <div className="text-xs text-muted-foreground">
                        观察到 {memory.evidenceCount} 次 · 最近 {formatDateTime(memory.lastSeenAt)}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void handleDelete(memory)}
                      disabled={deletingId === memory.id}
                      aria-label="删除记忆"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )
      })}

      <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          记忆按「被观察到的次数 + 新近度」排序，问答时最多注入前 10 条，仅作背景参考——与当前问题冲突时
          Agent 会忽略记忆。同类表述会自动合并（配置向量模型后按语义合并），总量上限 30 条，超出时淘汰最少被验证的。
        </span>
      </div>
    </div>
  )
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
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
