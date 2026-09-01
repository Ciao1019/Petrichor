import { cn } from "@/lib/utils"
import type {
  DocumentImportJobResponse,
  DocumentImportJobStatus,
} from "@/lib/api"

export const STATUS_META: Record<DocumentImportJobStatus, { label: string; className: string }> = {
  pending: { label: "等待中", className: "bg-muted text-muted-foreground" },
  processing: { label: "进行中", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  completed: { label: "已完成", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  failed: { label: "失败", className: "bg-destructive/10 text-destructive" },
  dead_letter: { label: "死信", className: "bg-destructive/15 text-destructive" },
  canceled: { label: "已取消", className: "bg-muted text-muted-foreground" },
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

export function resolveStatusMeta(job: DocumentImportJobResponse): { label: string; className: string } {
  if (job.status === "completed" && !job.articleId) {
    return { label: "待合并", className: "bg-sky-500/10 text-sky-600 dark:text-sky-400" }
  }
  if (job.status === "completed" && job.articleId) {
    return { label: "已生成文章", className: STATUS_META.completed.className }
  }
  if (job.status === "failed" && job.failedPages > 0) {
    return { ...STATUS_META.failed, label: "有失败页" }
  }
  return STATUS_META[job.status] ?? { label: "等待中", className: "bg-muted text-muted-foreground" }
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

export function resolveProgressPercent(job: DocumentImportJobResponse) {
  return job.totalPages > 0 ? Math.round((job.donePages / job.totalPages) * 100) : 0
}
