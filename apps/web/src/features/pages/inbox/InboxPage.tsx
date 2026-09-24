import * as React from "react"
import type { DiscussionUser } from "@/components/editor/plugins/discussion-kit"
import { BookOpen, Loader2, PencilLine, Pin, RefreshCw, Search, X } from "@/components/iconimate"
import { toast } from "sonner"

import { AppPagination } from "@/components/app-pagination"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { authApi, inboxApi, type InboxListResponse, type InboxNote, type InboxStatus } from "@/lib/api"
import { cn } from "@/lib/utils"
import { InboxCaptureComposer } from "./capture/InboxCaptureComposer"
import { InboxComposer } from "./InboxComposer"
import { InboxNoteCard } from "./InboxNoteCard"
import { InboxArchiveDialog } from "./InboxArchiveDialog"
import { INBOX_PAGE_SIZE } from "./inbox-utils"

const FILTERS: { value: InboxStatus; label: string }[] = [{ value: "inbox", label: "待整理" }, { value: "archived", label: "已归档" }, { value: "all", label: "全部" }]
const TAG_PREVIEW = 12

function ToolbarIconButton({ label, pressed, disabled, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
          className={cn("size-8 shrink-0 rounded-lg", pressed ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary" : "text-muted-foreground hover:text-foreground")}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>{label}</TooltipContent>
    </Tooltip>
  )
}

export function InboxPage() {
  const [userId, setUserId] = React.useState<string | null>(null)
  const [currentUser, setCurrentUser] = React.useState<DiscussionUser>()
  const [status, setStatus] = React.useState<InboxStatus>("inbox")
  const [keyword, setKeyword] = React.useState("")
  const [query, setQuery] = React.useState("")
  const [tag, setTag] = React.useState("")
  const [pinned, setPinned] = React.useState(false)
  const [tagsExpanded, setTagsExpanded] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [data, setData] = React.useState<InboxListResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  const [archiveNote, setArchiveNote] = React.useState<InboxNote | null>(null)
  const [editing, setEditing] = React.useState<InboxNote | null>(null)
  const [editBusy, setEditBusy] = React.useState(false)
  const [deleting, setDeleting] = React.useState<InboxNote | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [captureSource, setCaptureSource] = React.useState<{ id: string; requestedAt: number }>()
  const composerArea = React.useRef<HTMLDivElement>(null)
  const mutationRef = React.useRef(false)

  React.useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(keyword.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword])

  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void Promise.all([
      inboxApi.list({ status, keyword: query, tag, pinned, pageNum: page, pageSize: INBOX_PAGE_SIZE }, controller.signal),
      authApi.me(),
    ]).then(([response, user]) => {
      if (controller.signal.aborted) return
      setData(response.data)
      setUserId(user.data.id)
      setCurrentUser({ id: user.data.id, name: user.data.nickname || user.data.username || user.data.email, avatarUrl: user.data.avatar || undefined })
      const lastPage = Math.max(1, Math.ceil(response.data.total / INBOX_PAGE_SIZE))
      if (page > lastPage) setPage(lastPage)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(resolveAxiosErrorMessage(cause, "随笔加载失败，请重试"))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [status, query, tag, pinned, page, refresh])

  function selectTag(next: string) { setTag(next === tag ? "" : next); setPage(1) }
  function reload() { setRefresh((value) => value + 1) }
  function created() {
    toast.success("已记下来")
    setStatus("inbox"); setKeyword(""); setQuery(""); setTag(""); setPinned(false); setPage(1); reload()
  }

  async function pin(note: InboxNote) {
    if (mutationRef.current) return
    mutationRef.current = true
    setBusyId(note.id)
    try { await inboxApi.pin(note.id, !note.pinned); reload() }
    catch (cause) { toast.error(resolveAxiosErrorMessage(cause, "置顶操作失败")) }
    finally { mutationRef.current = false; setBusyId(null) }
  }

  async function remove() {
    if (!deleting || mutationRef.current) return
    mutationRef.current = true
    setBusyId(deleting.id)
    try { await inboxApi.delete(deleting.id, deleting.version); setDeleting(null); toast.success("随笔已删除"); reload() }
    catch (cause) { toast.error(resolveAxiosErrorMessage(cause, "删除失败")); setDeleting(null); reload() }
    finally { mutationRef.current = false; setBusyId(null) }
  }

  function clearFilters() { setKeyword(""); setTag(""); setPinned(false); setPage(1) }

  const filtered = Boolean(query || tag || pinned)
  const summary = data?.summary
  const tags = data?.tags ?? []
  // 标签较多时默认只露出前几项；当前选中的标签始终可见。
  const visibleTags = tagsExpanded || tags.length <= TAG_PREVIEW ? tags : tags.filter((item, index) => index < TAG_PREVIEW || item.name === tag)
  const hiddenTagCount = tags.length - visibleTags.length

  return (
    <div className="min-h-full">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
        {userId ? (
          <div ref={composerArea}><InboxCaptureComposer key={userId} userId={userId} currentUser={currentUser} onSaved={created} sourceRequest={captureSource} /></div>
        ) : (
          <div aria-busy={loading} className="flex min-h-40 items-center justify-center rounded-2xl border border-border/60 bg-card text-sm text-muted-foreground">
            {loading ? <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" /> : "随笔暂不可用，请重试"}
          </div>
        )}

        <section aria-label="随笔列表" aria-busy={loading} className="space-y-4">
          {/* 列表工具栏：状态、搜索和置顶过滤收在一行，标签作为下一行的可选过滤。 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 text-xs" aria-label="随笔分类">
                {FILTERS.map((filter) => {
                  const active = status === filter.value
                  const count = summary?.[filter.value === "all" ? "total" : filter.value]
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => { setStatus(filter.value); setPage(1) }}
                      className={cn(
                        "flex h-7 items-center gap-1.5 rounded-md px-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        active ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {filter.label}
                      <span className={cn("font-mono text-[10px] tabular-nums", active ? "text-muted-foreground" : "text-muted-foreground/60")}>{count ?? "–"}</span>
                    </button>
                  )
                })}
              </div>

              <div className="flex w-full items-center gap-1 sm:ml-auto sm:w-auto">
                <div className="relative min-w-0 flex-1 sm:w-52 sm:flex-none">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="搜索随笔"
                    placeholder="搜索随笔"
                    value={keyword}
                    maxLength={200}
                    className="h-8 rounded-lg border-border/60 bg-card/80 pl-8 pr-7 text-base shadow-none focus-visible:ring-1 md:text-xs"
                    onChange={(event) => setKeyword(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Escape" && keyword) { event.preventDefault(); setKeyword("") } }}
                  />
                  {keyword && (
                    <button
                      type="button"
                      aria-label="清空搜索"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setKeyword("")}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <ToolbarIconButton label={pinned ? "显示全部随笔" : "只看置顶"} pressed={pinned} onClick={() => { setPinned((value) => !value); setPage(1) }}>
                  <Pin className="size-3.5" />
                </ToolbarIconButton>
                <ToolbarIconButton label="刷新" disabled={loading} onClick={reload}>
                  <RefreshCw className={cn("size-3.5", loading && "motion-safe:animate-spin")} />
                </ToolbarIconButton>
              </div>
            </div>

            {tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" aria-label="按标签筛选">
                {visibleTags.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    aria-pressed={tag === item.name}
                    onClick={() => selectTag(item.name)}
                    className={cn(
                      "flex max-w-48 items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      tag === item.name ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <span className="truncate">#{item.name}</span>
                    <span className="shrink-0 text-[10px] tabular-nums opacity-60">{item.count}</span>
                  </button>
                ))}
                {(hiddenTagCount > 0 || tagsExpanded) && tags.length > TAG_PREVIEW && (
                  <button type="button" aria-expanded={tagsExpanded} onClick={() => setTagsExpanded((value) => !value)}
                    className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                    {tagsExpanded ? "收起" : `+${hiddenTagCount}`}
                  </button>
                )}
              </div>
            )}

            {filtered && data && !loading && !error && (
              <p className="text-xs text-muted-foreground">
                找到 <span className="font-mono tabular-nums text-foreground">{data.total}</span> 条
                {query && <>，包含「<span className="text-foreground">{query}</span>」</>}
                <button type="button" className="ml-2 rounded text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={clearFilters}>清除筛选</button>
              </p>
            )}
          </div>

          {error ? (
            <div role="alert" className="rounded-xl border border-destructive/20 bg-card px-6 py-10 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button type="button" variant="outline" size="sm" className="mt-4" onClick={reload}>重新加载</Button>
            </div>
          ) : loading && !data ? (
            <div role="status" aria-label="加载随笔" className="space-y-3">
              {[0, 1, 2].map((item) => (
                <div key={item} className="rounded-xl border border-border/40 bg-card/60 px-5 py-4 motion-safe:animate-pulse">
                  <div className="h-2.5 w-20 rounded bg-muted/70" />
                  <div className="mt-4 h-3 w-4/5 rounded bg-muted/60" />
                  <div className="mt-2.5 h-3 w-3/5 rounded bg-muted/60" />
                </div>
              ))}
            </div>
          ) : data?.rows.length ? (
            <div className={cn("space-y-3 transition-opacity", loading && "opacity-60")}>
              {data.rows.map((note) => (
                <InboxNoteCard
                  key={note.id}
                  note={note}
                  disabled={busyId === note.id}
                  onArchive={setArchiveNote}
                  onEdit={setEditing}
                  onDelete={setDeleting}
                  onPin={(item) => void pin(item)}
                  onTag={selectTag}
                  onSource={(id) => { setCaptureSource({ id, requestedAt: Date.now() }); composerArea.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }) }}
                />
              ))}
              {data.total > INBOX_PAGE_SIZE && (
                <AppPagination
                  className="pt-3"
                  page={page - 1}
                  pageSize={INBOX_PAGE_SIZE}
                  total={data.total}
                  totalPages={Math.ceil(data.total / INBOX_PAGE_SIZE)}
                  onChange={(value) => setPage(value + 1)}
                />
              )}
            </div>
          ) : loading ? null : (
            <div className="px-6 py-14 text-center">
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
                {filtered ? <Search className="size-4.5" /> : status === "archived" ? <BookOpen className="size-4.5" /> : <PencilLine className="size-4.5" />}
              </div>
              <h3 className="text-sm font-medium text-foreground">
                {filtered ? "没有匹配的随笔" : status === "archived" ? "还没有归档的随笔" : "随笔箱是空的"}
              </h3>
              <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">
                {filtered
                  ? "换个关键词，或清除标签与置顶筛选试试。"
                  : status === "archived"
                  ? "在随笔的操作菜单中选择「归档到知识库」，把灵感沉淀为正式文章。"
                  : "在上方随手写下此刻的想法，或粘贴链接采集一篇好文章。"}
              </p>
              {filtered && <Button type="button" variant="outline" size="sm" className="mt-4 h-7 text-xs" onClick={clearFilters}>清除筛选</Button>}
            </div>
          )}
        </section>
      </div>

      {archiveNote && <InboxArchiveDialog key={archiveNote.id} note={archiveNote} onClose={() => setArchiveNote(null)} onArchived={() => { setArchiveNote(null); reload() }} />}
      {editing && userId && <ModalShell open onOpenChange={(open) => { if (!open) setEditing(null) }} title="编辑随笔" description="修改内容与标签，保存后更新这条记录。" disableClose={editBusy} contentClassName="sm:max-w-3xl"><div className="overflow-hidden rounded-xl border border-border/70 bg-card"><InboxComposer key={editing.id} userId={userId} currentUser={currentUser} note={editing} onBusyChange={setEditBusy} onSaved={() => { setEditing(null); toast.success("随笔已更新"); reload() }} /></div></ModalShell>}
      {deleting && <ModalShell open onOpenChange={(open) => { if (!open) setDeleting(null) }} title="删除这篇随笔？" description={deleting.archivedAt ? "只删除这篇随笔，已归档的知识库文章会保留。" : "删除后无法恢复，请确认这条记录已不再需要。"} disableClose={busyId === deleting.id} footer={<><Button type="button" variant="outline" disabled={busyId === deleting.id} onClick={() => setDeleting(null)}>取消</Button><Button type="button" variant="destructive" disabled={busyId === deleting.id} onClick={() => void remove()}>{busyId === deleting.id && <Loader2 className="size-4 animate-spin" />}确认删除</Button></>} />}
    </div>
  )
}
