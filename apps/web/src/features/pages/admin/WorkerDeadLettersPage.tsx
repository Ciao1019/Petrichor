import { Loader2, RefreshCw, RotateCcw } from "@/components/iconimate"
import * as React from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { adminRuntimeJobsApi, type AdminDeadLetterJob } from "@/lib/api"

function formatDateTime(value: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    if (typeof response?.data?.msg === "string") return response.data.msg
  }
  return error instanceof Error ? error.message : "操作失败"
}

export function WorkerDeadLettersPage() {
  const [items, setItems] = React.useState<AdminDeadLetterJob[]>([])
  const [loading, setLoading] = React.useState(true)
  const [replaying, setReplaying] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminRuntimeJobsApi.deadLetters()
      setItems(response.data.items)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const replay = React.useCallback(async (job: AdminDeadLetterJob) => {
    if (!window.confirm(`确认重放“${job.title}”？任务会重新调用模型或文档处理流程。`)) return
    const key = `${job.kind}:${job.id}`
    setReplaying(key)
    try {
      await adminRuntimeJobsApi.replay({ kind: job.kind, id: job.id })
      setItems((current) => current.filter((item) => `${item.kind}:${item.id}` !== key))
      toast.success("任务已重放，Worker 将自动领取")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setReplaying(null)
    }
  }, [])

  return (
    <div className="flex flex-1 flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Worker 死信队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            查看耗尽自动重试的知识构建和视觉导入任务，并将任务原子重放到持久队列。
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">待处理死信</CardTitle>
          <CardDescription>重放会清零本轮尝试次数，但保留 replayCount 作为审计计数。</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && items.length === 0 ? (
            <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="min-h-32 content-center text-center text-sm text-muted-foreground">当前没有死信任务</div>
          ) : (
            <div className="divide-y rounded-lg border">
              {items.map((job) => {
                const key = `${job.kind}:${job.id}`
                const busy = replaying === key
                return (
                  <div key={key} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {job.kind === "knowledge_build" ? "知识构建" : "视觉导入"}
                        </Badge>
                        <span className="truncate font-medium">{job.title}</span>
                        <span className="font-mono text-xs text-muted-foreground">#{job.id}</span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-sm text-destructive">{job.lastError || "未记录错误"}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>尝试 {job.attemptCount}/{job.maxAttempts}</span>
                        <span>历史重放 {job.replayCount} 次</span>
                        <span>用户 #{job.userId}</span>
                        <span>死信时间 {formatDateTime(job.deadLetteredAt)}</span>
                      </div>
                    </div>
                    <Button size="sm" onClick={() => void replay(job)} disabled={replaying !== null}>
                      {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RotateCcw className="mr-2 size-4" />}
                      重放
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
