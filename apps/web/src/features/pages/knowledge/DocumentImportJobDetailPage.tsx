"use client"

import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AppPagination } from "@/components/app-pagination"
import {
  dashboardRoutes,
  knowledgeBaseArticlePath,
} from "@/lib/dashboard-routes"
import {
  documentImportApi,
  type DocumentImportJobResponse,
  type DocumentImportPageResponse,
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
  const [pages, setPages] = React.useState<DocumentImportPageResponse[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const loadDetail = React.useCallback(async (showSpinner = false) => {
    if (!jobId) return
    if (showSpinner) setLoading(true)
    try {
      const res = await documentImportApi.detail({ jobId })
      setJob(res.data.job)
      setPages(res.data.pages || [])
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

  const retryPage = React.useCallback(async (pageNo: number) => {
    if (!jobId) return
    setBusy(true)
    try {
      await documentImportApi.retryPage({ jobId, pageNo })
      await loadDetail(false)
      toast.success(`第 ${pageNo} 页已重试`)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "重试失败"))
    } finally {
      setBusy(false)
    }
  }, [jobId, loadDetail])

  const retryFailedPages = React.useCallback(async () => {
    if (!jobId) return
    setBusy(true)
    try {
      const res = await documentImportApi.retryFailedPages({ jobId })
      toast.success(`已重新开始识别 ${res.data.retried} 个失败页`)
      await loadDetail(false)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "重试失败页失败"))
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

  const finalizeJob = React.useCallback(async () => {
    if (!jobId || !job) return
    setBusy(true)
    try {
      const res = await documentImportApi.finalize({ jobId })
      toast.success("文章已生成")
      navigate(knowledgeBaseArticlePath(job.knowledgeBaseId, res.data.articleId))
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "生成文章失败"))
    } finally {
      setBusy(false)
    }
  }, [jobId, job, navigate])

  const pageSize = 10
  const [pageIndex, setPageIndex] = React.useState(0)

  const pageCount = Math.max(1, Math.ceil(pages.length / pageSize))
  // 数据刷新后把越界的页码夹回有效范围
  React.useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1))
  }, [pageCount])
  const visiblePages = React.useMemo(
    () => pages.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize),
    [pages, pageIndex, pageSize],
  )

  // 本地抽取页不消耗多模态额度，单独统计出来便于直观看到省下多少调用
  const localExtractedCount = React.useMemo(
    () => pages.filter((page) => page.extractedBy === "pdf").length,
    [pages],
  )

  const unfinishedPages = job ? Math.max(0, job.totalPages - job.donePages) : 0
  const canFinalize = Boolean(
    job &&
    !job.articleId &&
    job.status !== "canceled" &&
    job.totalPages > 0 &&
    job.donePages === job.totalPages,
  )

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold">{job ? job.title : "任务详情"}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {job ? `${job.sourceType.toUpperCase()} · ${job.fileName}` : "查看导入进度，重试失败页或手动合并文章。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
                  {job.failedPages > 0 ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => retryFailedPages()}>
                      <RefreshCw className={cn("mr-2 size-4", busy && "animate-spin")} />
                      重试全部失败页（{job.failedPages}）
                    </Button>
                  ) : null}
                  {job.status !== "completed" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => cancelJob()}>
                      取消任务
                    </Button>
                  ) : null}
                  <Button size="sm" disabled={busy || !canFinalize} onClick={() => finalizeJob()}>
                    合并生成文章
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {job.error ? <p className="text-sm text-destructive">{job.error}</p> : null}

          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">目标位置</div>
              <div className="mt-1 truncate font-medium">{resolveTargetText(job)}</div>
            </div>
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">页数进度</div>
              <div className="mt-1 font-medium">
                共 {job.totalPages} 页 · 已完成 {job.donePages} · 未完成 {unfinishedPages}
              </div>
            </div>
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">失败页</div>
              <div className={cn("mt-1 font-medium", job.failedPages > 0 && "text-destructive")}>
                {job.failedPages} 页
              </div>
            </div>
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">更新时间</div>
              <div className="mt-1 font-medium">{formatDateTime(job.updatedAt)}</div>
            </div>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", job.failedPages > 0 ? "bg-destructive" : "bg-primary")}
              style={{ width: `${resolveProgressPercent(job)}%` }}
            />
          </div>

          <div className="rounded-lg border">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-sm font-medium text-muted-foreground">
              <span>页面明细（{pages.length}）</span>
              {pages.length > 0 ? (
                <span className="text-xs font-normal">
                  本地抽取 {localExtractedCount} 页 · 模型识别 {pages.length - localExtractedCount} 页
                </span>
              ) : null}
            </div>
            <ul className="divide-y">
              {visiblePages.map((page) => (
                <li key={page.pageNo} className="flex flex-col gap-1 px-4 py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">第 {page.pageNo} 页</span>
                      <span
                        className={cn(
                          "text-xs",
                          page.status === "done" && "text-emerald-600 dark:text-emerald-400",
                          page.status === "failed" && "text-destructive",
                          page.status === "pending" && "text-muted-foreground",
                        )}
                      >
                        {page.status === "done" ? "已完成" : page.status === "failed" ? "失败" : "待处理"}
                      </span>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {page.extractedBy === "pdf" ? "本地抽取" : "模型识别"}
                      </span>
                    </span>
                    {page.status === "pending" && page.extractedBy === "vision" && !page.imageKey ? (
                      <span className="shrink-0 text-xs text-muted-foreground">等待上传页面图片</span>
                    ) : null}
                    {page.status === "failed" ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => retryPage(page.pageNo)}>
                        重试
                      </Button>
                    ) : null}
                  </div>
                  {page.error ? <p className="text-xs text-destructive">{page.error}</p> : null}
                </li>
              ))}
            </ul>
            {pages.length > 0 ? (
              <div className="border-t px-4 py-3">
                <AppPagination
                  page={pageIndex}
                  totalPages={pageCount}
                  total={pages.length}
                  pageSize={pageSize}
                  onChange={(nextPageIndex) => setPageIndex(nextPageIndex)}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentImportJobDetailPage
