import * as React from "react"
import { ArrowUp, Hash, Loader2, X } from "@/components/iconimate"
import { toast } from "sonner"

import type { DiscussionUser } from "@/components/editor/plugins/discussion-kit"
import type { PlateContentState, PlateMarkdownEditorHandle } from "@/components/plate/PlateMarkdownEditor"
import { Button } from "@/components/ui/button"
import { inboxApi, type InboxNote } from "@/lib/api"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { cn } from "@/lib/utils"
import { inboxDraftKey, INBOX_MAX_LENGTH, readInboxDraft, saveShortcutLabel, type InboxDraft } from "./inbox-utils"

const PlateMarkdownEditor = React.lazy(() => import("@/components/plate/PlateMarkdownEditor").then((module) => ({ default: module.PlateMarkdownEditor })))

export interface InboxComposerHandle { append: (value: { contentMd: string; tags: string[]; captureId: string }) => void }

interface Props {
  composerRef?: React.Ref<InboxComposerHandle>
  userId: string
  currentUser?: DiscussionUser
  note?: InboxNote
  onSaved: (note: InboxNote) => void
  onBusyChange?: (busy: boolean) => void
}

export function InboxComposer({ userId, currentUser, note, onSaved, onBusyChange, composerRef }: Props) {
  const [draft, setDraft] = React.useState(() => readInboxDraft(userId, note))
  const [tagInput, setTagInput] = React.useState("")
  const [showTags, setShowTags] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [pendingMedia, setPendingMedia] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const editorRef = React.useRef<PlateMarkdownEditorHandle>(null)
  const tagInputRef = React.useRef<HTMLInputElement>(null)
  const busyRef = React.useRef(false)
  const draftRef = React.useRef(draft)
  const busy = saving || pendingMedia
  const length = Array.from(draft.contentMd.trim()).length
  const overLimit = length > INBOX_MAX_LENGTH
  const canSave = draft.contentMd.trim().length > 0 && !overLimit && !busy
  const editorUser = React.useMemo(() => currentUser ?? { id: userId, name: "我" }, [currentUser, userId])
  const submitLabel = note ? "保存修改" : "记下来"

  const persistDraft = React.useCallback((value: InboxDraft) => {
    if (note) return
    try {
      if (value.contentMd.trim() || value.tags.length) localStorage.setItem(inboxDraftKey(userId), JSON.stringify(value))
      else localStorage.removeItem(inboxDraftKey(userId))
    } catch { /* 存储空间不足时保留内存草稿，服务端保存仍可用。 */ }
  }, [note, userId])

  const handleContentChange = React.useCallback((next: PlateContentState) => {
    const value = { ...draftRef.current, contentMd: next.markdown, contentJson: next.contentJson, contentMetaJson: next.contentMetaJson }
    draftRef.current = value
    setDraft(value)
    persistDraft(value)
  }, [persistDraft])

  React.useEffect(() => { draftRef.current = draft; persistDraft(draft) }, [draft, persistDraft])
  React.useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  // 点击「添加标签」后直接进入输入状态。
  React.useEffect(() => { if (showTags) tagInputRef.current?.focus() }, [showTags])
  React.useEffect(() => {
    // 刷新或离开页面时，读取实时编辑器状态，避免漏掉最后一次输入。
    const flush = () => { editorRef.current?.getContentState() }
    window.addEventListener("pagehide", flush)
    return () => window.removeEventListener("pagehide", flush)
  }, [])

  React.useImperativeHandle(composerRef, () => ({ append(value) {
    if (busy || busyRef.current || !editorRef.current || editorRef.current.hasPendingMedia()) throw new Error("请等待编辑器加载或当前附件上传完成")
    const current = editorRef.current.getContentState()
    if (Array.from(current.markdown + value.contentMd).length + 4 > INBOX_MAX_LENGTH) throw new Error("追加后超过 20,000 字，请减少原文选段或保存为新随笔")
    const captureIds = [...new Set([...(draftRef.current.captureIds ?? []), value.captureId])]
    const tags = [...new Set([...draftRef.current.tags, ...value.tags])]
    if (captureIds.length > 20 || tags.length > 20 || tags.some((tag) => Array.from(tag).length > 80)) throw new Error("追加后来源或标签超过上限，请保存为新随笔")
    const next = editorRef.current.appendMarkdown(value.contentMd)
    const merged = { ...draftRef.current, contentMd: next.markdown, contentJson: next.contentJson, contentMetaJson: next.contentMetaJson, captureIds, tags }
    draftRef.current = merged; setDraft(merged); persistDraft(merged)
    toast.success("已追加到草稿，可继续编辑；⌘ / Ctrl + Z 撤销正文追加")
  } }), [busy, persistDraft])

  function addTag() {
    const tag = tagInput.trim().replace(/^#+/, "")
    if (!tag) return
    if (Array.from(tag).length > 80 || draft.tags.length >= 20) { toast.error("最多 20 个标签，每个不超过 80 字"); return }
    setDraft((current) => ({ ...current, tags: [...new Set([...current.tags, tag])] }))
    setTagInput("")
  }

  function removeTag(tag: string) {
    setDraft((current) => ({ ...current, tags: current.tags.filter((value) => value !== tag) }))
  }

  async function save() {
    if (busyRef.current || !editorRef.current) return
    if (editorRef.current.hasPendingMedia()) { setError("请等待附件上传完成；上传失败的附件可重试或移除。"); return }
    // 工具栏和输入变化可能尚未触发草稿回调，提交始终读取实时快照。
    const latest = editorRef.current.getContentState()
    const contentMd = latest.markdown.trim()
    if (!contentMd || Array.from(contentMd).length > INBOX_MAX_LENGTH) return
    const pendingTag = tagInput.trim().replace(/^#+/, "")
    const tags = [...new Set([...draftRef.current.tags, ...(pendingTag ? [pendingTag] : [])])]
    if (tags.length > 20 || tags.some((tag) => Array.from(tag).length > 80)) { setError("最多 20 个标签，每个不超过 80 字"); return }
    busyRef.current = true
    setSaving(true)
    setError(null)
    try {
      const input = { ...(draftRef.current.captureIds?.length ? { captureIds: draftRef.current.captureIds } : {}), contentMd, contentJson: latest.contentJson, contentMetaJson: latest.contentMetaJson, tags }
      const { data } = note ? await inboxApi.update({ ...input, id: note.id, version: note.version }) : await inboxApi.create({ ...input, clientId: draftRef.current.clientId })
      if (!note) {
        const empty: InboxDraft = { contentMd: "", contentJson: null, contentMetaJson: null, tags: [], clientId: crypto.randomUUID() }
        draftRef.current = empty
        persistDraft(empty)
        setDraft(empty)
        setTagInput("")
        setShowTags(false)
      }
      onSaved(data)
    } catch (cause) { setError(resolveAxiosErrorMessage(cause, "保存失败，内容已保留，请重试")) }
    finally { busyRef.current = false; setSaving(false) }
  }

  // 标签、字数与提交按钮并入编辑器底部操作条，避免编辑区下方再叠一层工具栏。
  const actions = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {draft.tags.map((tag) => (
        <span key={tag} className="inline-flex max-w-40 items-center gap-0.5 rounded-md bg-muted/70 py-0.5 pl-1.5 pr-0.5 font-mono text-[11px] text-foreground/80">
          <span className="truncate">#{tag}</span>
          <button type="button" disabled={saving} aria-label={`移除标签 ${tag}`} onClick={() => removeTag(tag)}
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <X className="size-3" />
          </button>
        </span>
      ))}
      {showTags ? (
        <input ref={tagInputRef} aria-label="新标签" value={tagInput} disabled={saving} placeholder="输入标签后回车" maxLength={80}
          className="h-6 w-32 rounded-md border border-border/70 bg-background px-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring"
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter") { event.preventDefault(); addTag() }
            else if (event.key === "Escape") { event.preventDefault(); setTagInput(""); setShowTags(false) }
            else if (event.key === "Backspace" && !tagInput && draft.tags.length) removeTag(draft.tags[draft.tags.length - 1]!)
          }}
          onBlur={() => { addTag(); setShowTags(false) }} />
      ) : (
        <button type="button" aria-label="添加标签" disabled={saving || draft.tags.length >= 20} onClick={() => setShowTags(true)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
          <Hash className="size-3.5" />{draft.tags.length === 0 && <span>标签</span>}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2.5 pl-2">
        {length > 0 && <span className={cn("font-mono text-[11px] tabular-nums", overLimit ? "font-semibold text-destructive" : "text-muted-foreground/70")}>{overLimit ? `${length.toLocaleString()} / ${INBOX_MAX_LENGTH.toLocaleString()}` : `${length.toLocaleString()} 字`}</span>}
        <Button type="button" size="sm" aria-label={submitLabel} disabled={!canSave} onClick={() => void save()} className="h-8 gap-1.5 rounded-lg px-3 text-xs font-medium">
          {saving ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <ArrowUp className="size-3.5" />}
          {submitLabel}
          <kbd aria-hidden="true" className="hidden font-mono text-[10px] opacity-60 sm:inline">{saveShortcutLabel()}</kbd>
        </Button>
      </div>
    </div>
  )

  return (
    <section aria-label={note ? "编辑随笔" : "随笔编辑器"} className="min-w-0"
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); void save()
        }
      }}>
      <React.Suspense fallback={<div className="min-h-36" aria-hidden="true" />}>
        <PlateMarkdownEditor key={draft.clientId} ref={editorRef} ariaLabel="随笔内容" compact changeDelayMs={0}
          className="rounded-none border-0 bg-transparent" currentUser={editorUser}
          initialMarkdown={draft.contentMd} initialContentJson={draft.contentJson} initialContentMetaJson={draft.contentMetaJson}
          disabled={saving} placeholder="此刻在想什么？输入 / 使用更多格式"
          onContentStateChange={handleContentChange} onPendingMediaChange={setPendingMedia} compactActions={actions} />
      </React.Suspense>
      {pendingMedia && <p role="status" className="border-t border-border/40 px-4 py-1.5 text-xs text-muted-foreground sm:px-5">附件上传完成后即可保存；上传失败时可点击附件重试或移除。</p>}
      {error && <p role="alert" className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive sm:px-5">{error}</p>}
    </section>
  )
}
