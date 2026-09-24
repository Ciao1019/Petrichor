import * as React from "react"
import { Check, Download, ExternalLink, Globe, Hash, Loader2, MoreHorizontal, PencilLine, RefreshCw, Sparkles, Trash2 } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { PlateMarkdownEditorHandle } from "@/components/plate/PlateMarkdownEditor"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { inboxApi } from "@/lib/api-inbox"
import type { CaptureJob } from "@/lib/api-capture"
import { cn } from "@/lib/utils"
import { InboxMarkdown } from "../InboxMarkdown"
import { INBOX_MAX_LENGTH } from "../inbox-utils"
import { buildCaptureMarkdown, downloadMarkdown, initialSelection, sourceHost, type CaptureSelection } from "./capture-utils"

const PlateEditor = React.lazy(() => import("@/components/plate/PlateMarkdownEditor").then((m) => ({ default: m.PlateMarkdownEditor })))
export interface CaptureAppend { contentMd: string; tags: string[]; captureId: string }
interface Props { userId: string; job: CaptureJob; leading?: React.ReactNode; onSaved: () => void; onAppend: (value: CaptureAppend) => void; onRegenerate: () => void; onUpdate: () => void; onDelete: () => void; actionBusy: boolean; modelReady: boolean }
interface PreviewDraft { selection: CaptureSelection; thought: string; tags: string; manual: string | null; contentJson?: string | null; contentMetaJson?: string | null; clientId: string }

export function CapturePreview({ userId, job, leading, onSaved, onAppend, onRegenerate, onUpdate, onDelete, actionBusy, modelReady }: Props) {
  const result = job.result!
  const key = `petrichor:capture-preview:${userId}:${job.id}`
  const [draft, setDraft] = React.useState<PreviewDraft>(() => {
    const fallback: PreviewDraft = { selection: initialSelection(result), thought: "", tags: result.note.tags.join(", "), manual: null, clientId: crypto.randomUUID() }
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) || "null")
      if (saved && typeof saved === "object" && "clientId" in saved && typeof saved.clientId === "string" && "thought" in saved && typeof saved.thought === "string" && "tags" in saved && typeof saved.tags === "string" && "selection" in saved && saved.selection && typeof saved.selection === "object") {
        const selection = saved.selection
        if ("assets" in selection && Array.isArray(selection.assets) && selection.assets.every((x) => typeof x === "string") && "links" in selection && Array.isArray(selection.links) && selection.links.every((x) => typeof x === "string")) return { ...fallback, ...saved } as PreviewDraft
      }
    } catch { /* 保留可用的服务器结果。 */ }
    return fallback
  })
  const [view, setView] = React.useState("note")
  const [editing, setEditing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(job.saved)
  const [error, setError] = React.useState("")
  const editorRef = React.useRef<PlateMarkdownEditorHandle>(null)
  const saveRef = React.useRef(false)
  const markdown = draft.manual ?? buildCaptureMarkdown(result, draft.selection, draft.thought)
  const length = Array.from(markdown).length
  const sourceLength = Array.from(result.markdown).length
  const hasNote = Boolean(result.note.summary || result.note.takeaways.length || result.note.quotes.length)
  const originalOmitted = !hasNote && !draft.selection.original && draft.manual === null
  const tags = [...new Set(draft.tags.split(/[,，\n]/).map((s) => s.trim().replace(/^#+/, "")).filter(Boolean))]
  const updateDraft = (patch: Partial<PreviewDraft>) => setDraft((current) => ({ ...current, ...patch }))

  React.useEffect(() => { try { localStorage.setItem(key, JSON.stringify(draft)) } catch { /* 空间不足时保留当前内存草稿。 */ } }, [draft, key])
  React.useEffect(() => { if (job.saved) setSaved(true) }, [job.saved])

  function content() {
    return editing && editorRef.current ? editorRef.current.getContentState() : { markdown, contentJson: draft.contentJson, contentMetaJson: draft.contentMetaJson }
  }
  function finishEditing() {
    if (!editing) return
    const latest = content()
    updateDraft({ manual: latest.markdown, contentJson: latest.contentJson, contentMetaJson: latest.contentMetaJson })
    setEditing(false)
  }
  function append() {
    try {
      if (editorRef.current?.hasPendingMedia()) throw new Error("请等待附件上传完成")
      onAppend({ contentMd: content().markdown, tags, captureId: job.id })
    } catch (cause) { setError(cause instanceof Error ? cause.message : "追加失败") }
  }
  async function save() {
    if (saveRef.current || saved) return
    const latest = content()
    if (Array.from(latest.markdown).length > INBOX_MAX_LENGTH || !latest.markdown.trim()) { setError("随笔正文须为 1 到 20,000 字，可编辑缩减内容；完整原文仍然保留。"); return }
    if (tags.length > 20 || tags.some((t) => Array.from(t).length > 80)) { setError("最多 20 个标签，每个不超过 80 字"); return }
    if (editorRef.current?.hasPendingMedia()) { setError("请等待附件上传完成"); return }
    saveRef.current = true
    setSaving(true)
    setError("")
    try {
      await inboxApi.create({ clientId: draft.clientId, contentMd: latest.markdown, contentJson: latest.contentJson, contentMetaJson: latest.contentMetaJson, tags, captureIds: [job.id] })
      setEditing(false)
      setSaved(true)
      onSaved()
    } catch (cause) { setError(resolveAxiosErrorMessage(cause, "保存失败，编辑内容已保留")) }
    finally { saveRef.current = false; setSaving(false) }
  }

  const views = [{ id: "note", label: hasNote ? "整理后的笔记" : "收藏内容" }, { id: "source", label: "完整原文" }]
  const scrollArea = "max-h-[26rem] min-w-0 overflow-y-auto overscroll-contain pr-1 [&_.plate-article-content>:first-child]:mt-0 [&_.plate-article-content_h1]:text-2xl [&_.plate-article-content_h2]:text-xl [&_.plate-article-content_h3]:text-base"
  return (
    <section aria-label="采集结果">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border/50 px-2 py-2 sm:px-3">
        {leading}
        <a href={result.url} target="_blank" rel="noreferrer" title={result.url} className="inline-flex min-w-0 max-w-[60%] items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:max-w-none">
          <Globe className="size-3.5 shrink-0" /><span className="truncate">{sourceHost(result.url)}</span><ExternalLink className="size-3 shrink-0 opacity-60" />
        </a>
        <span className="hidden text-xs text-muted-foreground/70 sm:inline">{result.cachedAt ? "缓存于 " : "采集于 "}{new Date(result.cachedAt || result.fetchedAt).toLocaleDateString("zh-CN")}</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="inline-flex rounded-lg bg-muted/60 p-0.5" aria-label="结果视图">
            {views.map((item) => <button type="button" key={item.id} aria-pressed={view === item.id} disabled={saving} onClick={() => { finishEditing(); setView(item.id) }}
              className={cn("h-7 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", view === item.id ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
              {item.label}
            </button>)}
          </div>
          {view === "note" && !saved && <Button type="button" variant="ghost" size="icon" aria-label={editing ? "完成编辑" : "编辑正文"} title={editing ? "完成编辑" : "编辑正文"} aria-pressed={editing} disabled={saving} className="size-8 text-muted-foreground hover:text-foreground" onClick={() => { if (editing) finishEditing(); else setEditing(true) }}>
            {editing ? <Check className="size-4" /> : <PencilLine className="size-4" />}
          </Button>}
          {view === "source" && <Button type="button" variant="ghost" size="icon" aria-label="下载完整原文" title="下载完整原文" className="size-8 text-muted-foreground hover:text-foreground" onClick={() => downloadMarkdown(result.markdown, result.note.title)}><Download className="size-4" /></Button>}
        </div>
      </header>
      <div className="space-y-4 px-4 py-4 sm:px-6">
        {result.warnings.length > 0 && <details className="text-xs leading-5 text-muted-foreground"><summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">采集说明 · {result.warnings.length} 项</summary><ul className="mt-2 list-disc space-y-1 pl-4">{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        {view === "note" ? <>
          {originalOmitted && <p role="status" className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-6">这篇文章较长，完整原文已单独保留。你可以保存来源以便回看，或先用 AI 整理成笔记。</p>}
          <div className={scrollArea} aria-label="笔记正文">
            {editing ? <React.Suspense fallback={<p role="status" className="text-sm text-muted-foreground">加载编辑器…</p>}>
              <PlateEditor ref={editorRef} initialMarkdown={markdown} initialContentJson={draft.contentJson} initialContentMetaJson={draft.contentMetaJson} compact changeDelayMs={0} disabled={saving} ariaLabel="采集笔记正文" className="rounded-xl shadow-none"
                onContentStateChange={(next) => updateDraft({ manual: next.markdown, contentJson: next.contentJson, contentMetaJson: next.contentMetaJson })} />
            </React.Suspense> : <InboxMarkdown content={markdown} contentJson={draft.contentJson} contentMetaJson={draft.contentMetaJson} />}
          </div>
        </> : <>
          <p className="text-xs text-muted-foreground">{sourceLength.toLocaleString()} 字 · 完整原文独立保留</p>
          <div className={scrollArea} aria-label="网页原文"><InboxMarkdown content={result.markdown} /></div>
          {result.assets.some((asset) => asset.url) && <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">查看历史附件</summary><div className="mt-3 flex flex-wrap gap-3">{result.assets.filter((asset) => asset.url).map((asset, index) => <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{asset.kind === "screenshot" ? "网页快照" : `图片 ${index + 1}`}</a>)}</div></details>}
          {result.diff && <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">{result.change === "unchanged" ? "网页内容没有变化" : "查看网页变化"}</summary><pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 leading-6">{result.diff}</pre></details>}
        </>}
        {/* 想法与标签直接展开：保存前最常做的补充，不再藏在折叠面板里。 */}
        {view === "note" && !saved && <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/15 transition-colors focus-within:border-ring/60">
          {draft.manual === null
            ? <><label htmlFor="capture-thought" className="sr-only">我的想法</label><Textarea id="capture-thought" rows={1} disabled={saving} value={draft.thought} maxLength={10000} onChange={(event) => updateDraft({ thought: event.target.value })} placeholder="为什么值得留下？记一句自己的理解（可选）" className="max-h-40 min-h-11 resize-none rounded-none border-0 bg-transparent! px-3 py-2.5 shadow-none focus-visible:ring-0" /></>
            : <p className="px-3 py-2.5 text-xs text-muted-foreground">正文已手动编辑，可以直接在正文里补充想法。</p>}
          <div className="flex items-center gap-2 border-t border-border/40 px-3">
            <Hash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <label htmlFor="capture-tags" className="sr-only">标签，用逗号分隔</label>
            <Input id="capture-tags" value={draft.tags} disabled={saving} onChange={(event) => updateDraft({ tags: event.target.value })} maxLength={1600} placeholder="标签，用逗号分隔" className="h-9 rounded-none border-0 bg-transparent! px-0 font-mono text-base shadow-none focus-visible:ring-0 md:text-xs" />
          </div>
        </div>}
      </div>
      {error && <p role="alert" className="px-4 pb-3 text-sm text-destructive sm:px-6">{error}</p>}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/50 px-3 py-2.5 sm:px-4">
        {!saved && <Button type="button" variant="ghost" size="sm" disabled={saving || actionBusy} onClick={onDelete} className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" />删除</Button>}
        <span role="status" className={cn("min-w-0 text-xs", length > INBOX_MAX_LENGTH ? "text-destructive" : "text-muted-foreground")}>
          {saved ? <span className="inline-flex items-center gap-1.5"><Check className="size-3.5" />已保存，可在下方随笔中查看</span> : length > INBOX_MAX_LENGTH ? "正文超过 20,000 字，请编辑缩减" : originalOmitted ? "将保存文章来源" : "原文与来源会一并保留"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label="更多采集操作" disabled={saving || actionBusy} className="size-8"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem disabled={!modelReady} onSelect={onRegenerate}><Sparkles className="size-4" /><span>{hasNote ? "重新整理" : "AI 整理原文"}<span className="block text-xs text-muted-foreground">使用已有原文，消耗模型用量</span></span></DropdownMenuItem>
              <DropdownMenuItem disabled={length > INBOX_MAX_LENGTH} onSelect={append}><PencilLine className="size-4" />追加到随手写草稿</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => downloadMarkdown(result.markdown, result.note.title)}><Download className="size-4" />下载完整原文</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onUpdate}><RefreshCw className="size-4" /><span>重新采集网页<span className="block text-xs text-muted-foreground">获取最新内容，消耗采集用量</span></span></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" size="sm" disabled={saving || actionBusy || saved || length > INBOX_MAX_LENGTH} onClick={() => void save()} className="h-8 rounded-lg px-3 text-xs font-medium">
            {saving && <Loader2 className="size-3.5 motion-safe:animate-spin" />}{saved ? "已保存" : saving ? "正在保存" : originalOmitted ? "保存来源到随笔" : "保存到随笔"}
          </Button>
        </div>
      </footer>
    </section>
  )
}
