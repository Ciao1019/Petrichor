import { ProgressiveFluxLoader } from "@/components/ruixen/progressive-flux-loader"
import type { DocumentImportJobResponse, DocumentImportPageResponse } from "@/lib/api"
import { IMAGE_POLICY_LABELS } from "@/components/knowledge/document-import-policy"
import {
  countSuccessfulMethods,
  METHOD_LABELS,
  resolveJobProgress,
  resolvePageMethodLabel,
  resolvePageUnit,
} from "./document-import-job-shared"

export function DocumentImportProgress({ job }: { job: DocumentImportJobResponse }) {
  const progress = resolveJobProgress(job)
  return (
    <div className="min-w-0 space-y-2 whitespace-normal">
      <ProgressiveFluxLoader
        {...progress}
        gradient={job.failedPages > 0 ? "var(--destructive)" : undefined}
      />
      {job.totalPages > 0 && job.status !== "completed" ? (
        <p className="text-xs text-muted-foreground">
          未完成 {Math.max(0, job.totalPages - job.donePages)} {resolvePageUnit(job)}
          {job.failedPages > 0 ? ` · 失败 ${job.failedPages}` : ""}
        </p>
      ) : null}
    </div>
  )
}

export function DocumentImportMethods({
  job,
  pages,
}: {
  job: DocumentImportJobResponse
  pages?: DocumentImportPageResponse[]
}) {
  const counts = pages ? countSuccessfulMethods(pages) : {
    direct: job.directPages ?? 0,
    multimodal: job.multimodalPages ?? 0,
  }
  const methods = (Object.keys(METHOD_LABELS) as Array<keyof typeof METHOD_LABELS>)
    .filter((method) => counts[method] > 0)
  return (
    <div className="min-w-0 space-y-2 whitespace-normal text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-3 gap-y-1" aria-label="成功来源统计">
        {Object.entries(METHOD_LABELS).map(([method, label]) => (
          <span key={method}>{label} {counts[method as keyof typeof counts]}</span>
        ))}
      </div>
      <p>{methods.length > 1 ? "混合方式" : "实际方式"}：{methods.map((method) => METHOD_LABELS[method]).join(" + ") || "尚无成功单元"}</p>
      {job.sourceType === "pdf" ? <p>图片处理：{IMAGE_POLICY_LABELS[job.imagePolicy ?? "keep_and_recognize"]}</p> : null}
    </div>
  )
}

export function DocumentImportPageMethod({ page, imagePolicy }: { page: DocumentImportPageResponse; imagePolicy?: DocumentImportJobResponse["imagePolicy"] }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border px-1.5 py-0.5">{resolvePageMethodLabel(page, imagePolicy)}</span>
      </div>
    </div>
  )
}
