import * as React from "react"
import { Check, Loader2, Sparkles } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { inboxApi, type InboxArchiveRecommendation as Recommendation, type InboxNote, type InboxSuggestedDestination } from "@/lib/api"

interface Props {
  note: InboxNote
  disabled: boolean
  applied: boolean
  onResult: (result: Recommendation) => void
  onApply: (destination: InboxSuggestedDestination | null, tags: string[]) => void
}

export function InboxArchiveRecommendation({ note, disabled, applied, onResult, onApply }: Props) {
  const [config, setConfig] = React.useState<{ enabled: boolean; demo?: boolean } | null>(null)
  const [configError, setConfigError] = React.useState(false)
  const [retry, setRetry] = React.useState(0)
  const [result, setResult] = React.useState<Recommendation | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const request = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    void inboxApi.recommendationConfig(controller.signal).then(({ data }) => {
      if (!controller.signal.aborted) { setConfig(data); setConfigError(false) }
    }).catch(() => { if (!controller.signal.aborted) setConfigError(true) })
    return () => { controller.abort(); request.current?.abort() }
  }, [retry])

  async function recommend() {
    if (request.current || disabled) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(null)
    try {
      const { data } = await inboxApi.recommend(note.id, note.version, controller.signal)
      if (!controller.signal.aborted) { setResult(data); onResult(data) }
    } catch (cause) {
      if (!controller.signal.aborted) setError(resolveAxiosErrorMessage(cause, "推荐暂时不可用，你可以继续手动归档"))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
      request.current = null
    }
  }

  if (configError && !config) return <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
    <span>暂时无法获取智能推荐状态，可继续手动归档。</span>
    <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setRetry((value) => value + 1)}>重试推荐状态</Button>
  </div>
  if (!config) return <p role="status" className="text-xs text-muted-foreground">正在检查智能推荐…</p>
  if (!config.enabled) return <p className="text-xs text-muted-foreground">智能推荐尚未启用，可以手动选择归档位置。</p>

  return <section aria-label="归档智能推荐" className="rounded-xl border border-border/70 bg-muted/25 p-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-muted-foreground" />智能推荐</div>
      <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => void recommend()}>
        {loading && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {loading ? "正在分析…" : result ? "重新推荐" : "获取推荐"}
      </Button>
    </div>
    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{config.demo ? "演示建议，仅展示交互，不调用 Jev。" : "使用 Jev 分析随笔内容，推荐已有分类和标签。采纳后仍可调整。"}</p>
    {loading && <p role="status" className="mt-3 text-xs text-muted-foreground">正在匹配知识库、文件夹和已有标签…</p>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {result && <div aria-live="polite" className="mt-3 space-y-3 border-t border-border/60 pt-3">
      {result.destination ? <div className="space-y-1">
        <p className="break-words text-sm font-medium">{result.destination.knowledgeBaseName}</p>
        <p className="break-words text-xs leading-relaxed text-muted-foreground">{result.destination.folderPath}</p>
      </div> : <p className="text-sm leading-relaxed">{result.status === "uncertain" ? "暂时无法确定最合适的位置，可以从这些候选中选择。" : "暂未找到合适的知识库，可以保持待整理，或手动选择位置。"}</p>}
      {result.alternatives.length > 0 && <div className="flex flex-wrap gap-2">{result.alternatives.map((destination) => <Button key={destination.knowledgeBaseId} type="button" variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-1.5 text-left" disabled={disabled || loading} onClick={() => onApply(destination, [])}>{destination.knowledgeBaseName}</Button>)}</div>}
      {result.tags.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="推荐标签">{result.tags.map((tag) => <span key={tag} className="max-w-full break-words rounded-md border bg-background px-2 py-1 text-xs">#{tag}</span>)}</div>}
      {result.warnings.map((warning) => <p key={warning} className="text-xs leading-relaxed text-muted-foreground">{warning}</p>)}
      {(result.destination || result.tags.length > 0) && <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={disabled || loading || applied} onClick={() => onApply(result.destination, result.tags)}>{applied && <Check className="size-3.5" />}{applied ? "已采纳" : result.destination ? "一键采纳" : "采纳推荐标签"}</Button>
        {applied && <span role="status" className="text-xs text-muted-foreground">已填入下方，确认归档后保存。</span>}
      </div>}
    </div>}
  </section>
}
