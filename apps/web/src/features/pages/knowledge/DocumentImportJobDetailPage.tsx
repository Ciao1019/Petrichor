"use client"

import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  dashboardRoutes,
  knowledgeBaseArticlePath,
} from "@/lib/dashboard-routes"
import {
  documentImportApi,
  type DocumentImportJobResponse,
} from "@/lib/api"
import {
  StatusBadge,
  formatDateTime,
  resolveApiErrorMessage,
  resolveProgressPercent,
  resolveTargetText,
} from "@/features/pages/knowledge/document-import-job-shared"

export function DocumentImportJobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()

  const [job, setJob] = React.useState<DocumentImportJobResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const loadDetail = React.useCallback(async (showSpinner = false) => {
    if (!jobId) return
    if (showSpinner) setLoading(true)
    try {
      const res = await documentImportApi.detail({ jobId })
      setJob(res.data.job)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "加载任务详情失败"))
    } finally {
      if (showSpinner) setLoading(false)
    }
  }, [jobId])

  React.useEffect(() => {
    void loadDetail(true)
  }, [loadDetail])

  React.useEffect(() => {
    if (!job || (job.status !== "pending" && job.status !== "processing")) {
      return
    }
    const timer = window.setInterval(() => {
      void loadDetail(false)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [job, loadDetail])

  const retryJob = React.useCallback(async () => {
    if (!jobId) return
    setBusy(true)
    try {
      await documentImportApi.retry({ jobId })
      await loadDetail(false)
      toast.success("已重新开始解析")
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "重试失败"))
    } finally {
      setBusy(false)
    }
  }, [jobId, loadDetail])

  const cancelJob = React.useCallback(async () => {
    if (!jobId) return
    setBusy(true)
    try {
      await documentImportApi.cancel({ jobId })
      await loadDetail(false)
      toast.success("任务已取消")
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "取消失败"))
    } finally {
      setBusy(false)
    }
  }, [jobId, loadDetail])

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold">{job ? job.title : "任务详情"}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {job ? `${job.sourceType.toUpperCase()} · ${job.fileName}` : "查看解析进度或重试。"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => loadDetail(true)} disabled={loading}>
            <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />
            刷新
          </Button>
          <Button variant="outline" onClick={() => navigate(dashboardRoutes.imports)}>
            <ArrowLeft className="mr-2 size-4" />
            返回列表
          </Button>
        </div>
      </div>

      {loading && !job ? (
        <div className="flex items-center justify-center rounded-lg border py-16 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载中…
        </div>
      ) : !job ? (
        <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">任务不存在或已被删除</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-4">
            <StatusBadge job={job} />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {job.articleId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(knowledgeBaseArticlePath(job.knowledgeBaseId, job.articleId as string))}
                >
                  打开文章
                </Button>
              ) : null}
              {!job.articleId && job.status !== "canceled" ? (
                <>
                  {job.status === "failed" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => retryJob()}>
                      <RefreshCw className={cn("mr-2 size-4", busy && "animate-spin")} />
                      重试解析
                    </Button>
                  ) : null}
                  {job.status === "pending" || job.status === "processing" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => cancelJob()}>
                      取消任务
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          {job.error ? <p className="text-sm text-destructive">{job.error}</p> : null}

          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">目标位置</div>
              <div className="mt-1 truncate font-medium">{resolveTargetText(job)}</div>
            </div>
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">解析进度</div>
              <div className="mt-1 font-medium">
                {job.totalPages > 0
                  ? `已解析 ${job.processedPages} / ${job.totalPages} 页`
                  : `${resolveProgressPercent(job)}%`}
              </div>
            </div>
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">更新时间</div>
              <div className="mt-1 font-medium">{formatDateTime(job.updatedAt)}</div>
            </div>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", job.status === "failed" ? "bg-destructive" : "bg-primary")}
              style={{ width: `${resolveProgressPercent(job)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentImportJobDetailPage
