import * as React from "react"
import { AlertCircle, ArrowLeft, Check, ChevronDown, Circle, Globe, History, Loader2, RefreshCw, Trash2, XCircle } from "@/components/iconimate"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { captureApi, type CaptureConfig, type CaptureJob, type CaptureOptions } from "@/lib/api-capture"
import { cn } from "@/lib/utils"
import { CaptureInput } from "./CaptureInput"
import { CapturePreview, type CaptureAppend } from "./CapturePreview"
import { captureBusy, captureStates, defaultCaptureOptions, parseCaptureURLs, simpleCaptureOptions, sourceHost } from "./capture-utils"

interface Props { userId: string; active: boolean; sourceRequest?: { id: string; requestedAt: number }; onSaved: () => void; onAppend: (value: CaptureAppend) => void }
export function CaptureWorkspace({ userId, active, sourceRequest, onSaved, onAppend }: Props) {
  const storageKey = `petrichor:capture-input:${userId}`
  const [input, setInput] = React.useState(() => {
    const fallback = { urls: "", options: { ...defaultCaptureOptions }, clientId: crypto.randomUUID() as string }
    try { const raw = JSON.parse(localStorage.getItem(storageKey) || "null") as Partial<typeof fallback> | null; if (raw && typeof raw.urls === "string" && raw.options && ["read", "quote", "assets"].includes(raw.options.mode)) return { ...fallback, ...raw, options: simpleCaptureOptions(raw.options) } as typeof fallback } catch { /* 旧草稿不可用时恢复默认值。 */ }
    return fallback
  })
  const [config, setConfig] = React.useState<CaptureConfig | null>(null)
  const [jobs, setJobs] = React.useState<CaptureJob[]>([])
  const [duplicates, setDuplicates] = React.useState<CaptureJob[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [selectedId, setSelectedId] = React.useState(sourceRequest?.id || "")
  const [selected, setSelected] = React.useState<CaptureJob | null>(null)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const historyId = React.useId()
  const [deleting, setDeleting] = React.useState<CaptureJob | null>(null)
  const [deleteError, setDeleteError] = React.useState("")
  const removedIds = React.useRef(new Set<string>())
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [loadError, setLoadError] = React.useState("")
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0)
  const mutation = React.useRef(false)
  const regenerateIds = React.useRef(new Map<string, string>())
  const updateIds = React.useRef(new Map<string, string>())
  React.useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(input)) } catch { /* 存储受限时仍保留内存输入。 */ } }, [input, storageKey])
  React.useEffect(() => { if (sourceRequest) { setSelectedId(sourceRequest.id); setSelected(null); refresh() } }, [sourceRequest])
  React.useEffect(() => {
    if (!active) return
    const controller = new AbortController(); let timer: number | undefined
    const load = async () => {
      try {
        const [settings, history, detail] = await Promise.all([captureApi.config(controller.signal), captureApi.list(page, controller.signal), selectedId ? captureApi.result(selectedId, controller.signal) : Promise.resolve(null)])
        if (controller.signal.aborted) return
        const visible = history.data.rows.filter((job) => !removedIds.current.has(job.id))
        setConfig(settings.data); setJobs(visible); setTotal(Math.max(0, history.data.total - (history.data.rows.length - visible.length)))
        if (detail && !removedIds.current.has(detail.data.id)) setSelected(detail.data)
        setLoadError("")
      } catch (cause) { if (!controller.signal.aborted) setLoadError(resolveAxiosErrorMessage(cause, "采集记录加载失败，请重试")) }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = window.setTimeout(() => void load(), 4000) } }
    }
    void load()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [active, page, selectedId, revision])
  function updateInput(patch: { urls?: string; options?: CaptureOptions }) { setError(""); setInput((current) => ({ ...current, ...patch, clientId: crypto.randomUUID() })) }
  async function act(fn: () => Promise<void>) {
    if (mutation.current) return
    mutation.current = true; setBusy(true); setError("")
    try { await fn(); refresh() } catch (cause) { setError(resolveAxiosErrorMessage(cause, cause instanceof Error ? cause.message : "操作失败，请重试")) }
    finally { mutation.current = false; setBusy(false) }
  }
  function select(job: CaptureJob) { setSelectedId(job.id); setSelected(job); setHistoryOpen(false) }
  React.useEffect(() => {
    if (!active || !input.urls.trim()) { setDuplicates([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      try {
        const urls = parseCaptureURLs(input.urls, config?.maxBatch ?? 10)
        void captureApi.lookup(urls, controller.signal).then(({ data }) => { if (!controller.signal.aborted) setDuplicates(data.rows.filter((job) => !removedIds.current.has(job.id))) }).catch(() => { if (!controller.signal.aborted) setDuplicates([]) })
      } catch { setDuplicates([]) }
    }, 400)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [active, input.urls, config?.maxBatch, revision])
  async function create() {
    if (!config) return
    await act(async () => {
      const urls = parseCaptureURLs(input.urls, config.maxBatch)
      const useAI = input.options.engine !== "none"
      if (useAI && !config.modelReady && !config.aiFormats) throw new Error("AI 整理暂不可用，请先配置对话模型或切换为收藏原文")
      const options = simpleCaptureOptions({ engine: useAI ? (config.modelReady ? "model" : "firecrawl") : "none" })
      const { data } = await captureApi.create({ urls, options, clientId: input.clientId })
      if (data.jobs[0]) select(data.jobs[0]); setPage(1)
      setInput((current) => ({ ...current, urls: "", clientId: crypto.randomUUID() }))
    })
  }
  async function checkUpdate(job: CaptureJob) {
    await act(async () => {
      let clientId = updateIds.current.get(job.id)
      if (!clientId) { clientId = crypto.randomUUID(); updateIds.current.set(job.id, clientId) }
      const { data } = await captureApi.create({ urls: [job.url], options: { ...job.options, fresh: true }, previousId: job.result ? job.id : undefined, clientId })
      updateIds.current.delete(job.id); if (data.jobs[0]) select(data.jobs[0]); setPage(1)
    })
  }
  async function regenerate(job: CaptureJob) {
    await act(async () => {
      let clientId = regenerateIds.current.get(job.id)
      if (!clientId) { clientId = crypto.randomUUID(); regenerateIds.current.set(job.id, clientId) }
      const { data } = await captureApi.regenerate(job.id, clientId); regenerateIds.current.delete(job.id); select(data); setPage(1)
    })
  }
  function requestDelete(job: CaptureJob) {
    setDeleteError("")
    setDeleting(job)
  }
  async function remove() {
    if (!deleting || mutation.current) return
    const id = deleting.id
    mutation.current = true
    setBusy(true)
    setDeleteError("")
    try {
      await captureApi.delete(id)
      removedIds.current.add(id)
      setJobs((current) => current.filter((job) => job.id !== id))
      setDuplicates((current) => current.filter((job) => job.id !== id))
      setTotal((current) => Math.max(0, current - 1))
      if (selectedId === id) { setSelectedId(""); setSelected(null) }
      if (jobs.length === 1 && page > 1) setPage(page - 1)
      try { localStorage.removeItem(`petrichor:capture-preview:${userId}:${id}`) } catch { /* 存储受限不影响服务端删除。 */ }
      regenerateIds.current.delete(id)
      updateIds.current.delete(id)
      setDeleting(null)
      refresh()
    } catch (cause) { setDeleteError(resolveAxiosErrorMessage(cause, "删除失败，采集内容已保留，请重试")) }
    finally { mutation.current = false; setBusy(false) }
  }
  const duplicate = duplicates[0]
  const busyCount = jobs.filter(captureBusy).length
  const showPreview = Boolean(selected?.result && ["ready", "partial"].includes(selected.state))
  const back = <Button type="button" variant="ghost" size="sm" disabled={busy} className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setSelectedId(""); setSelected(null) }}><ArrowLeft className="size-3.5" />继续采集</Button>
  return (
    <section className="min-w-0" aria-label="网页采集">
      {selectedId && !showPreview && (
        <div className="flex min-w-0 items-center gap-2 border-b border-border/50 px-2 py-2 sm:px-3">
          {back}
          {selected && <span className="min-w-0 truncate text-xs text-muted-foreground">{selected.title || sourceHost(selected.url)}</span>}
        </div>
      )}
      <div hidden={Boolean(selectedId)}>
        {config ? <CaptureInput urls={input.urls} options={input.options} config={config} busy={busy} onURLs={(urls) => updateInput({ urls })} onOptions={(options) => updateInput({ options })} onSubmit={() => void create()} />
          : <div role="status" className="flex min-h-28 items-center justify-center gap-2 p-5 text-sm text-muted-foreground">{loading && <Loader2 className="size-4 motion-safe:animate-spin" />}{loading ? "正在准备网页采集…" : "网页采集暂不可用"}</div>}
        {duplicate && <p className="-mt-1 px-4 pb-3 text-xs text-muted-foreground sm:px-5">这个网址已有采集记录。<button type="button" className="ml-1 rounded font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => select(duplicate)}>查看已有内容</button></p>}
      </div>
      {(error || loadError) && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-t border-destructive/15 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"><span>{error || loadError}</span>{loadError && <Button type="button" size="sm" variant="ghost" className="h-7" onClick={refresh}><RefreshCw className="size-3.5" />重试</Button>}</div>}
      {selectedId && !selected && !loadError && <div role="status" className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 motion-safe:animate-spin" />正在打开文章…</div>}
      {selected && captureBusy(selected) && <CaptureProgress job={selected} disabled={busy} onCancel={() => void act(async () => { await captureApi.cancel(selected.id) })} />}
      {selected && ["failed", "cancelled"].includes(selected.state) && (
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <span className={cn("flex size-9 items-center justify-center rounded-full", selected.state === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
            {selected.state === "failed" ? <AlertCircle className="size-4" /> : <XCircle className="size-4" />}
          </span>
          <div>
            <p className="text-sm font-medium">{captureStates[selected.state]}</p>
            <p role="alert" className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{selected.error || "没有生成新内容，可以重新尝试。"}</p>
          </div>
          <div className="flex justify-center gap-2"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void checkUpdate(selected)}><RefreshCw className="size-3.5" />重新采集</Button>{!selected.saved && <Button type="button" size="sm" variant="ghost" disabled={busy} className="text-muted-foreground hover:text-destructive" onClick={() => requestDelete(selected)}><Trash2 className="size-3.5" />删除记录</Button>}</div>
          <p className="text-[11px] text-muted-foreground/70">重试会再次消耗采集用量。</p>
        </div>
      )}
      {showPreview && selected && <CapturePreview key={selected.id} userId={userId} job={selected} leading={back} onSaved={() => { onSaved(); refresh() }} onAppend={onAppend} onRegenerate={() => void regenerate(selected)} onUpdate={() => void checkUpdate(selected)} onDelete={() => requestDelete(selected)} actionBusy={busy} modelReady={config?.modelReady ?? false} />}
      {total > 0 && (
        <div className="border-t border-border/50">
          <button type="button" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen} aria-controls={historyId}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5">
            <History className="size-3.5" /><span>采集记录</span><span className="font-mono tabular-nums">{total}</span>
            {busyCount > 0 && <span className="inline-flex items-center gap-1 text-foreground/80"><Loader2 className="size-3 motion-safe:animate-spin" />{busyCount} 篇处理中</span>}
            <ChevronDown className={cn("ml-auto size-3.5 transition-transform motion-reduce:transition-none", historyOpen && "rotate-180")} />
          </button>
          <div id={historyId} hidden={!historyOpen} className="px-2 pb-2 sm:px-3">
            <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="采集记录列表">
              {jobs.map((job) => (
                <li key={job.id} className={cn("group/row flex min-w-0 items-center gap-1 rounded-lg transition-colors", selectedId === job.id ? "bg-muted" : "hover:bg-muted/50")}>
                  <button type="button" onClick={() => select(job)} aria-pressed={selectedId === job.id} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring">
                    {captureBusy(job) ? <Loader2 className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin" /> : job.saved ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : <Globe className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm">{job.title || job.url}</span><span className="block truncate text-[11px] text-muted-foreground">{sourceHost(job.url)} · {new Date(job.createdAt).toLocaleDateString("zh-CN")}</span></span>
                    <span className={cn("shrink-0 text-[11px]", job.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{job.saved ? "已保存" : captureStates[job.state]}</span>
                  </button>
                  {!job.saved && <Button type="button" variant="ghost" size="icon" className="mr-1 size-8 shrink-0 text-muted-foreground hover:text-destructive sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100" aria-label={`删除采集：${job.title || job.url}`} disabled={busy} onClick={() => requestDelete(job)}><Trash2 className="size-3.5" /></Button>}
                </li>
              ))}
            </ul>
            {total > 20 && <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground"><Button type="button" variant="ghost" size="sm" className="h-7" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="font-mono tabular-nums">{page} / {Math.ceil(total / 20)}</span><Button type="button" variant="ghost" size="sm" className="h-7" disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>下一页</Button></div>}
          </div>
        </div>
      )}
      {deleting && <ModalShell open onOpenChange={(open) => { if (!open && !busy) setDeleting(null) }} title="删除这条采集记录？"
        description={captureBusy(deleting) ? "任务会停止后续处理并从记录中移除，已发生的采集用量不会返还。" : "未保存的内容将从采集记录中移除，删除后不能在页面中恢复。"}
        disableClose={busy}
        footer={<><Button type="button" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>{busy && <Loader2 className="size-4 motion-safe:animate-spin" />}确认删除</Button></>}>
        <p className="break-all text-sm text-muted-foreground">{deleting.title || deleting.url}</p>
        {deleteError && <p role="alert" className="mt-3 text-sm text-destructive">{deleteError}</p>}
      </ModalShell>}
    </section>
  )
}

// 排队 → 采集 → 整理的轻量进度，让用户知道任务停在哪一步；收藏原文不显示整理步骤。
function CaptureProgress({ job, disabled, onCancel }: { job: CaptureJob; disabled: boolean; onCancel: () => void }) {
  const steps = ["排队", "采集网页", ...(job.options.engine !== "none" ? ["AI 整理"] : [])]
  const current = Math.min(steps.length - 1, job.state === "queued" ? 0 : job.state === "scraping" ? 1 : 2)
  return (
    <div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
      <span role="status" className="sr-only">{captureStates[job.state]}</span>
      <ol className="flex flex-wrap items-center justify-center gap-2 text-xs" aria-label="采集进度">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-2" aria-current={index === current ? "step" : undefined}>
            {index > 0 && <span aria-hidden="true" className={cn("h-px w-6 sm:w-10", index <= current ? "bg-foreground/40" : "bg-border")} />}
            <span className={cn("flex items-center gap-1.5", index === current ? "font-medium text-foreground" : index < current ? "text-muted-foreground" : "text-muted-foreground/50")}>
              {index < current ? <Check className="size-3.5" /> : index === current ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Circle className="size-3" />}
              {step}
            </span>
          </li>
        ))}
      </ol>
      <p className="max-w-full break-all text-xs text-muted-foreground">{sourceHost(job.url)} · 可以离开，任务会在后台继续</p>
      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" disabled={disabled} onClick={onCancel}>取消采集</Button>
    </div>
  )
}
