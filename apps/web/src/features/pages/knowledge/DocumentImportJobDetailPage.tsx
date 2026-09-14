"use client"

import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Loader2, RefreshCw } from "@/components/iconimate"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AppPagination } from "@/components/app-pagination"
import { dashboardRoutes, knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import { documentImportApi, type DocumentImportJobResponse, type DocumentImportPageResponse } from "@/lib/api"
import {
  StatusBadge, formatDateTime, resolveApiErrorMessage, resolveTargetText,
  resolvePageUnit, isOcrPage, canRetryImportPage, canRetryImportPreparation, isJobActive,
} from "./document-import-job-shared"
import { DocumentImportMethods, DocumentImportPageMethod, DocumentImportProgress } from "./document-import-job-components"
import { DocumentImportAssets } from "./document-import-assets"
import { IMAGE_POLICY_DESCRIPTIONS } from "@/components/knowledge/document-import-policy"

function pageStatusLabel(status: DocumentImportPageResponse["status"]) {
  if (status === "done") return "已完成"
  if (status === "failed") return "失败"
  if (status === "dead_letter") return "死信"
  if (status === "processing") return "处理中"
  return "待处理"
}

export function DocumentImportJobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const [job, setJob] = React.useState<DocumentImportJobResponse | null>(null)
  const [pages, setPages] = React.useState<DocumentImportPageResponse[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const [pageIndex, setPageIndex] = React.useState(0)
  const scope = React.useMemo(() => ({ jobId, active: false, request: 0, mutating: false }), [jobId])
  React.useLayoutEffect(() => {
    scope.active = true
    setJob(null)
    setPages([])
    setPageIndex(0)
    setBusy(false)
    setLoading(false)
    return () => { scope.active = false; scope.request += 1 }
  }, [scope])

  const loadDetail = React.useCallback(async (showSpinner = false, afterMutation = false) => {
    if (!scope.jobId || !scope.active || (scope.mutating && !afterMutation)) return
    const request = ++scope.request
    const isCurrent = () => scope.active && request === scope.request
    setLoading(showSpinner)
    try {
      const res = await documentImportApi.detail({ jobId: scope.jobId })
      if (!isCurrent()) return
      setJob(res.data.job)
      setPages(res.data.pages || [])
    } catch (error) {
      if (isCurrent()) toast.error(resolveApiErrorMessage(error, "加载任务详情失败"))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [scope])

  React.useEffect(() => { void loadDetail(true) }, [loadDetail])
  React.useEffect(() => {
    if (!job || job.id !== jobId || !isJobActive(job)) return
    const timer = window.setInterval(() => { void loadDetail(false) }, 4000)
    return () => window.clearInterval(timer)
  }, [job, jobId, loadDetail])

  const runJobAction = async <T,>(action: () => Promise<T>, onSuccess: (result: T) => void, errorMessage: string) => {
    if (!scope.active || scope.mutating) return
    // 写操作先废弃旧快照，并阻止刷新 / 轮询读取重试前的状态。
    scope.mutating = true
    scope.request += 1
    setLoading(false)
    setBusy(true)
    try {
      const result = await action()
      if (scope.active) onSuccess(result)
    } catch (error) {
      if (scope.active) toast.error(resolveApiErrorMessage(error, errorMessage))
    } finally {
      if (scope.active) {
        await loadDetail(false, true)
        scope.mutating = false
        if (scope.active) setBusy(false)
      }
    }
  }
  const retryPage = (pageNo: number) => {
    if (!jobId) return
    return runJobAction(() => documentImportApi.retryPage({ jobId, pageNo }), () => {
      toast.success(`第 ${pageNo} ${job ? resolvePageUnit(job) : "单元"}已提交重试`)
    }, "重试失败")
  }
  const retryFailedPages = () => {
    if (!jobId) return
    return runJobAction(() => documentImportApi.retryFailedPages({ jobId }), (res) => {
      toast.success(res.data.reset || (job && canRetryImportPreparation(job)) ? "已重新提交服务端解析，无需重新上传原件" : `已重新开始识别 ${res.data.retried} 个失败单元`)
    }, "重试失败单元失败")
  }
  const cancelJob = () => {
    if (!jobId) return
    return runJobAction(() => documentImportApi.cancel({ jobId }), () => toast.success("任务已取消"), "取消失败")
  }
  const finalizeJob = () => {
    if (!jobId || !job) return
    return runJobAction(() => documentImportApi.finalize({ jobId }), (res) => {
      setJob(res.data.job)
      if (res.data.articleId) {
        toast.success("文章已生成")
        navigate(knowledgeBaseArticlePath(res.data.job.knowledgeBaseId, res.data.articleId))
      } else {
        toast.success("已提交生成文章任务，可关闭页面")
      }
    }, "提交生成文章任务失败")
  }

  const pageSize = 10
  const pageCount = Math.max(1, Math.ceil(pages.length / pageSize))
  React.useEffect(() => { setPageIndex((current) => Math.min(current, pageCount - 1)) }, [pageCount])
  const visiblePages = pages.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize)
  const retryableCount = pages.filter(canRetryImportPage).length
  const unit = job ? resolvePageUnit(job) : "单元"
  const canFinalize = Boolean(job && !job.articleId && job.status !== "canceled" && !isJobActive(job) && job.totalPages > 0 && job.donePages === job.totalPages)
  const canRetryPreparation = Boolean(job && canRetryImportPreparation(job))

  return (
    <div className="flex w-full min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold">{job ? job.title : "任务详情"}</h1>
          <p className="break-words text-sm text-muted-foreground">{job ? `${job.sourceType.toUpperCase()} · ${job.fileName}` : "查看解析、识别与生成文章进度，重试失败步骤。"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void loadDetail(true)} disabled={loading}><RefreshCw className={cn("mr-2 size-4", loading && "animate-spin motion-reduce:animate-none")} />刷新</Button>
          <Button variant="outline" onClick={() => navigate(dashboardRoutes.imports)}><ArrowLeft className="mr-2 size-4" />返回列表</Button>
        </div>
      </div>
      {loading && !job ? (
        <div className="flex items-center justify-center rounded-lg border py-16 text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" />加载中…</div>
      ) : !job ? (
        <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">任务不存在或已被删除</div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-4">
            <StatusBadge job={job} />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {job.articleId ? <Button size="sm" variant="outline" onClick={() => navigate(knowledgeBaseArticlePath(job.knowledgeBaseId, job.articleId as string))}>打开文章</Button> : null}
              {!job.articleId && job.status !== "canceled" ? (
                <>
                  {canRetryPreparation || retryableCount > 0 ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void retryFailedPages()}>{canRetryPreparation ? "重试服务端解析" : `重试失败单元（${retryableCount}）`}</Button> : null}
                  {job.status !== "completed" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancelJob()}>取消任务</Button> : null}
                  <Button size="sm" disabled={busy || !canFinalize} onClick={() => void finalizeJob()}>{canFinalize && (job.status === "failed" || job.status === "dead_letter") ? "重试生成文章" : "提交生成文章"}</Button>
                </>
              ) : null}
            </div>
          </div>
          {job.error ? <p className="break-words text-sm text-destructive">{job.error}</p> : null}
          {job.deadLetteredAt ? <p className="text-xs text-muted-foreground">已于 {formatDateTime(job.deadLetteredAt)} 进入死信队列 · 历史重放 {job.replayCount} 次</p> : null}
          <p className="text-sm text-muted-foreground">原文件已保存，可关闭页面；失败步骤可在这里重试，无需重新上传。耗尽自动重试的任务也会显示在管理员死信队列。</p>
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="min-w-0 rounded-lg border px-4 py-3"><div className="text-xs text-muted-foreground">目标位置</div><div className="mt-1 break-words font-medium">{resolveTargetText(job)}</div></div>
            <div className="rounded-lg border px-4 py-3"><div className="text-xs text-muted-foreground">{unit}进度</div><div className="mt-1 font-medium">{job.totalPages > 0 ? `共 ${job.totalPages} ${unit} · 成功 ${job.donePages}` : "总量待确认"}</div></div>
            <div className="rounded-lg border px-4 py-3"><div className="text-xs text-muted-foreground">失败单元</div><div className={cn("mt-1 font-medium", job.failedPages > 0 && "text-destructive")}>{job.failedPages} {unit}</div></div>
            <div className="rounded-lg border px-4 py-3"><div className="text-xs text-muted-foreground">更新时间</div><div className="mt-1 font-medium">{formatDateTime(job.updatedAt)}</div></div>
          </div>
          <div className="space-y-4 rounded-lg border p-4">
            <DocumentImportProgress job={job} />
            <DocumentImportMethods job={job} pages={pages} />
            <p className="text-xs text-muted-foreground">{job.sourceType === "pdf" ? `PDF 原生正文始终保留。${IMAGE_POLICY_DESCRIPTIONS[job.imagePolicy ?? "keep_and_recognize"]}此 PDF 按物理页处理。` : "此文件按文档单元解析，不代表物理页数。"}来源统计只计成功单元。</p>
          </div>
          <div className="rounded-lg border">
            <div className="border-b px-4 py-2 text-sm font-medium text-muted-foreground">{unit}明细（{pages.length}）</div>
            <ul className="divide-y">
              {visiblePages.map((page) => (
                <li key={page.pageNo} className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">第 {page.pageNo} {unit}</span>
                      <span className={cn("text-xs", page.status === "done" ? "text-emerald-600 dark:text-emerald-400" : canRetryImportPage(page) ? "text-destructive" : "text-muted-foreground")}>{pageStatusLabel(page.status)}</span>
                    </span>
                    {canRetryImportPage(page) && job.status !== "canceled" && !job.articleId ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retryPage(page.pageNo)}>重试</Button> : null}
                  </div>
                  <DocumentImportPageMethod page={page} imagePolicy={job.imagePolicy} />
                  <DocumentImportAssets page={page} imagePolicy={job.imagePolicy} />
                  {isOcrPage(page) && page.attemptCount > 0 ? <p className="text-xs text-muted-foreground">自动尝试 {page.attemptCount}/{page.maxAttempts}{page.status === "pending" && isJobActive(job) ? ` · 下次调度 ${formatDateTime(page.nextAttemptAt)}` : ""}</p> : null}
                  {page.lastError || page.error ? <p className="break-words text-xs text-destructive">{page.lastError || page.error}</p> : null}
                </li>
              ))}
            </ul>
            {pages.length > 0 ? <div className="border-t px-4 py-3"><AppPagination page={pageIndex} totalPages={pageCount} total={pages.length} pageSize={pageSize} onChange={setPageIndex} /></div> : <p className="p-4 text-sm text-muted-foreground">单元明细尚未就绪</p>}
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentImportJobDetailPage
