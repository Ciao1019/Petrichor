import { cn } from "@/lib/utils"
import type {
  DocumentImportJobResponse,
  DocumentImportJobStatus,
  DocumentImportJobStage,
  DocumentImportMethod,
  DocumentImportPageResponse,
} from "@/lib/api"

export const STATUS_META: Record<DocumentImportJobStatus, { label: string; className: string }> = {
  pending: { label: "等待后台转换", className: "bg-muted text-muted-foreground" },
  processing: { label: "后台转换中", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  completed: { label: "已完成", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  failed: { label: "失败", className: "bg-destructive/10 text-destructive" },
  dead_letter: { label: "死信", className: "bg-destructive/15 text-destructive" },
  canceled: { label: "已取消", className: "bg-muted text-muted-foreground" },
}

export const METHOD_LABELS: Record<DocumentImportMethod, string> = {
  direct: "直接解析",
  multimodal: "多模态",
}

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) return apiMsg
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function isJobActive(job: DocumentImportJobResponse) {
  return job.status === "pending" || job.status === "processing"
}

export const STAGE_LABELS: Record<DocumentImportJobStage, string> = {
  preparing: "服务端准备",
  parsing: "服务端解析",
  rendering: "服务端栅格化",
  ocr: "后台 OCR",
  finalizing: "生成文章",
  completed: "已完成",
}

/** 历史响应缺少 stage 时按状态 / 页数推导；零页绝不推导为成文阶段。 */
export function resolveJobStage(job: DocumentImportJobResponse): DocumentImportJobStage {
  if (job.status === "completed") return "completed"
  if (job.stage && job.stage !== "completed" && !(job.stage === "finalizing" && job.totalPages <= 0)) return job.stage
  if (job.totalPages <= 0) return job.status === "pending" ? "preparing" : "parsing"
  return job.donePages >= job.totalPages ? "finalizing" : "ocr"
}

export function canRetryImportPreparation(job: DocumentImportJobResponse) {
  return !job.articleId && job.totalPages <= 0 && (job.status === "failed" || job.status === "dead_letter")
}

export function isGeneratingArticle(job: DocumentImportJobResponse) {
  return isJobActive(job) && job.totalPages > 0 && resolveJobStage(job) === "finalizing"
}

export function resolveStatusMeta(job: DocumentImportJobResponse): { label: string; className: string } {
  if (isGeneratingArticle(job)) {
    return { label: "生成文章中", className: "bg-sky-500/10 text-sky-600 dark:text-sky-400" }
  }
  if (isJobActive(job)) return { ...STATUS_META[job.status], label: `${STAGE_LABELS[resolveJobStage(job)]}中` }
  if (job.status === "completed" && job.articleId) {
    return { label: "已生成文章", className: STATUS_META.completed.className }
  }
  if (canRetryImportPreparation(job)) return { ...STATUS_META[job.status], label: `${STAGE_LABELS[resolveJobStage(job)]}失败${job.status === "dead_letter" ? " · 死信" : ""}` }
  if (job.status === "failed" && job.failedPages > 0) {
    return { ...STATUS_META.failed, label: "有失败单元" }
  }
  return STATUS_META[job.status] ?? STATUS_META.pending
}

export function StatusBadge({ job }: { job: DocumentImportJobResponse }) {
  const meta = resolveStatusMeta(job)
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", meta.className)}>
      {meta.label}
    </span>
  )
}

export function resolveTargetText(job: DocumentImportJobResponse) {
  const knowledgeBase = job.knowledgeBaseName || `知识库 #${job.knowledgeBaseId}`
  const folder = job.parentFolderName || "知识库根目录"
  return `${knowledgeBase} / ${folder}`
}

export function resolvePageUnit(job: DocumentImportJobResponse) {
  return job.pageUnit === "document" ? "文档单元" : "页"
}

/** 仅页面成功率；全页成功但任务未完成时改用阶段，不伪装为整体 100%。 */
export function resolveProgressPercent(job: DocumentImportJobResponse): number | null {
  if (job.status === "completed") return 100
  if (job.totalPages <= 0 || ["preparing", "parsing", "rendering", "finalizing"].includes(resolveJobStage(job)) || job.donePages >= job.totalPages) return null
  return Math.max(0, Math.floor((job.donePages / job.totalPages) * 100))
}

export function resolveJobProgress(job: DocumentImportJobResponse) {
  const active = isJobActive(job)
  const unit = resolvePageUnit(job)
  const status = resolveStatusMeta(job).label
  return {
    value: resolveProgressPercent(job),
    active,
    label: isGeneratingArticle(job) ? "全部单元已成功，正在生成文章"
      : job.totalPages <= 0 ? `${status} · 总量待确认`
        : `${status} · 成功 ${job.donePages}/${job.totalPages} ${unit}`,
  }
}

export function countSuccessfulMethods(pages: DocumentImportPageResponse[]) {
  const counts: Record<DocumentImportMethod, number> = { direct: 0, multimodal: 0 }
  for (const page of pages) {
    if (page.status === "done" && page.extractedBy !== "ocr") counts[page.extractedBy] += 1
  }
  return counts
}

export function isOcrPage(page: DocumentImportPageResponse) {
  return page.extractedBy !== "direct"
}

export function canRetryImportPage(page: DocumentImportPageResponse) {
  return isOcrPage(page) && (page.status === "failed" || page.status === "dead_letter")
}

export function resolvePageMethodLabel(page: DocumentImportPageResponse, imagePolicy?: DocumentImportJobResponse["imagePolicy"]) {
  if (page.assets?.length && imagePolicy === "images_only") return "图片已保留 · 跳过识别"
  if (page.assets?.length && imagePolicy === "text_only") return page.status === "done" ? "图片文字已提取" : "图片文字识别中"
  if (page.assets?.length) return page.status === "done" ? "正文与图片已保留" : "图文分别处理中"
  if (page.extractedBy === "ocr") return "待 OCR 识别"
  const label = METHOD_LABELS[page.extractedBy]
  return page.status === "done" ? label : `${label}（未成功）`
}
