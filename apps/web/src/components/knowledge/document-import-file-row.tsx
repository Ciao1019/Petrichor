import { CheckCircle2, FileText, X } from "@/components/iconimate"
import { Input } from "@/components/ui/input"
import { ProgressiveFluxLoader } from "@/components/ruixen/progressive-flux-loader"
import { resolveItemProgress, type ImportItem } from "./use-document-import"

export function DocumentImportFileRow({ item, busy, onTitleChange, onRemove }: {
  item: ImportItem
  busy: boolean
  onTitleChange: (title: string) => void
  onRemove: () => void
}) {
  return (
    <div className="min-w-0 space-y-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {item.status === "done" ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
          <span className="truncate" title={item.file.name}>{item.file.name}</span>
        </span>
        {!busy && !["done", "submitted"].includes(item.status) ? (
          <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`移除 ${item.file.name}`} onClick={onRemove}>
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      {item.status === "pending" || item.status === "failed" ? (
        <Input value={item.title} disabled={busy || Boolean(item.request) || Boolean(item.jobId)} aria-label={`${item.file.name} 的文章标题`} placeholder="文章标题" className="h-8" onChange={(event) => onTitleChange(event.target.value)} />
      ) : null}
      <ProgressiveFluxLoader {...resolveItemProgress(item)} gradient={item.status === "failed" ? "var(--destructive)" : undefined} />
      {item.status === "failed" ? (
        <div className="space-y-1 break-words text-xs text-destructive" role="alert">
          <p>{item.error}</p>
          {!item.sourceKey ? <p>原文件尚未确认上传成功，请在此重试；上传并提交后才会出现在导入任务列表。</p> : null}
          {item.request ? <p>提交响应尚未确认；重试沿用已锁定的标题、选项和请求标识，不会重复创建任务。</p> : null}
        </div>
      ) : null}
      {item.status === "submitted" ? <p className="text-xs text-muted-foreground">任务已提交，可关闭页面。解析、栅格化、OCR 和生成文章由服务端继续执行，请在导入任务列表查看结果。</p> : null}
    </div>
  )
}
