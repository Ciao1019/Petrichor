import { ChevronUp, FileDown, FileUp, Flame, ListTree, RefreshCw, Save, Share2, Sparkles } from "@/components/iconimate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { type TocItem } from "@/features/pages/public/public-article-utils"
import { cn } from "@/lib/utils"
import * as React from "react"
import { createPortal } from "react-dom"
import {
  formatSaveTime
} from "./article-editor-draft-utils"

interface ArticleEditorActionBarProps {
  path?: string | null
  readOnly: boolean
  error: string | null
  dirty: boolean
  saveStatusText: string
  articleReady: boolean
  loading: boolean
  saving: boolean
  saveIntent: "MANUAL" | "AUTO" | null
  generatingSummary: boolean
  hasSummary: boolean
  importing: boolean
  isOwner: boolean
  refreshingCache: boolean
  onGenerateSummary: () => void
  onImport: () => void
  onExport: () => void
  onOpenChunks: () => void
  onOpenShare: () => void
  onOpenBurn: () => void
  onRefreshCache: () => void
  onSave: () => void
}

export function ArticleEditorActionBar(props: ArticleEditorActionBarProps) {
  const {
    path, readOnly, error, dirty, saveStatusText, articleReady, loading, saving, saveIntent,
    generatingSummary, hasSummary, importing, isOwner, refreshingCache, onGenerateSummary,
    onImport, onExport, onOpenChunks, onOpenShare, onOpenBurn, onRefreshCache, onSave,
  } = props
  return (
    <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        {path ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="truncate text-xs text-muted-foreground/60">{path}</p>
            {readOnly ? <Badge variant="secondary">只读</Badge> : null}
            {!readOnly ? (
              <span className={cn("select-none text-xs", error && dirty ? "text-destructive" : dirty ? "text-amber-600" : "text-muted-foreground/60")}>
                {saveStatusText}
              </span>
            ) : null}
          </div>
        ) : <span />}
      </div>
      <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto sm:shrink-0 sm:justify-end">
        {!readOnly ? <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={!articleReady || loading || saving || generatingSummary} onClick={onGenerateSummary}>
          <Sparkles className="size-3.5" /><span className="hidden text-sm sm:inline">{generatingSummary ? "总结中..." : hasSummary ? "重新总结" : "AI 总结"}</span>
        </Button> : null}
        {!readOnly ? <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={!articleReady || loading || saving || importing} onClick={onImport}>
          <FileUp className="size-3.5" /><span className="hidden text-sm sm:inline">{importing ? "导入中..." : "导入"}</span>
        </Button> : null}
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={loading || !articleReady} onClick={onExport}>
          <FileDown className="size-3.5" /><span className="hidden text-sm sm:inline">导出</span>
        </Button>
        {isOwner ? <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={!articleReady || loading} onClick={onOpenChunks}>
          <ListTree className="size-3.5" /><span className="hidden text-sm sm:inline">分片</span>
        </Button> : null}
        {isOwner ? <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={!articleReady} onClick={onOpenShare}>
          <Share2 className="size-3.5" /><span className="hidden text-sm sm:inline">公开分享</span>
        </Button> : null}
        {isOwner ? <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={!articleReady} onClick={onOpenBurn}>
          <Flame className="size-3.5" /><span className="hidden text-sm sm:inline">阅后即焚</span>
        </Button> : null}
        {!readOnly ? <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground" disabled={!articleReady || loading || saving || dirty || refreshingCache} onClick={onRefreshCache}>
          <RefreshCw className={cn("size-3.5", refreshingCache && "animate-spin")} /><span className="hidden text-sm sm:inline">{refreshingCache ? "刷新中..." : "刷新缓存"}</span>
        </Button> : null}
        {!readOnly ? <Button size="sm" className="h-8 gap-1.5 px-4" onClick={onSave} disabled={!dirty || loading || saving || !articleReady}>
          <Save className="size-3.5" />{saving && saveIntent !== "AUTO" ? "保存中..." : dirty ? "保存" : "已保存"}
        </Button> : null}
      </div>
    </div>
  )
}

export function ArticleSummaryPreview({
  summary,
  generatedAt,
  stale,
}: {
  summary: string | null
  generatedAt: string | null
  stale: boolean
}) {
  if (!summary?.trim()) return null

  return (
    <section className="mb-6 rounded-lg border border-primary/15 bg-primary/5 px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-primary">AI 总结</span>
        {stale ? (
          <Badge variant="outline" className="h-5 border-amber-500/40 text-[11px] text-amber-600">
            待重新生成
          </Badge>
        ) : null}
        {generatedAt ? (
          <span className="text-xs text-muted-foreground">
            {formatSaveTime(generatedAt)}
          </span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
        {summary}
      </p>
    </section>
  )
}

/* ─── Editor loading skeleton ────────────────────────────── */

export function ArticleEditorLoadingCard() {
  return (
    <div className="w-full px-6 py-6 lg:px-10 animate-in fade-in-0 duration-300">
      {/* Action bar skeleton */}
      <div className="flex items-center justify-between gap-4 mb-8">
        <div className="h-3.5 w-32 rounded-lg bg-muted/60 animate-pulse" />
        <div className="flex items-center gap-2">
          <div className="h-8 w-14 rounded-md bg-muted/60 animate-pulse" />
          <div className="h-8 w-14 rounded-md bg-muted/60 animate-pulse" />
          <div className="h-8 w-20 rounded-md bg-muted/60 animate-pulse" />
        </div>
      </div>
      {/* Title skeleton */}
      <div className="h-9 w-2/5 rounded-lg bg-muted/60 animate-pulse mb-3" />
      {/* Tags skeleton */}
      <div className="flex items-center gap-2 mb-8">
        <div className="h-5 w-16 rounded-full bg-muted/60 animate-pulse" />
        <div className="h-5 w-20 rounded-full bg-muted/60 animate-pulse" />
      </div>
      {/* Editor area skeleton */}
      <div className="rounded-lg border bg-muted/10 px-8 py-8 space-y-5">
        <div className="h-3.5 w-full rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-11/12 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-4/5 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-px w-full bg-muted/30" />
        <div className="h-3.5 w-full rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-3/4 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-5/6 rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-3.5 w-2/3 rounded-lg bg-muted/60 animate-pulse" />
      </div>
    </div>
  )
}

/* ─── Editor TOC overlay (portal + fixed) ──────────────── */

const LINE_W: Record<number, number> = { 2: 14, 3: 10, 4: 7 }
const LINE_W_ACTIVE: Record<number, number> = { 2: 22, 3: 18, 4: 13 }

export function EditorTocOverlay({
  navToc,
  activeHeadingId,
  rightOffset,
  topOffset,
  onTocClick,
}: {
  navToc: TocItem[]
  activeHeadingId: string
  rightOffset: number
  topOffset: number
  onTocClick: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const clickLockRef = React.useRef(false)

  React.useEffect(() => {
    if (clickLockRef.current) return
    const container = containerRef.current
    if (!container || !activeHeadingId) return
    const el = container.querySelector<HTMLElement>(`[data-toc-id="${activeHeadingId}"]`)
    if (!el) return
    const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top: scrollTarget, behavior: "smooth" })
  }, [activeHeadingId])

  const handleClick = React.useCallback((id: string) => {
    const container = containerRef.current
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-toc-id="${id}"]`)
      if (el) {
        const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
        container.scrollTo({ top: scrollTarget, behavior: "smooth" })
      }
    }
    clickLockRef.current = true
    onTocClick(id)
    setTimeout(() => { clickLockRef.current = false }, 900)
  }, [onTocClick])

  // Portal renders in <body>, so position:fixed is correctly relative to the real viewport.
  // rightOffset anchors the TOC to the editor card's right inner edge.
  return createPortal(
    <nav
      className="ftoc"
      ref={containerRef}
      aria-label="目录"
      style={{ right: rightOffset, top: topOffset }}
    >
      {navToc.map((item) => {
        const active = activeHeadingId === item.id
        const w = active ? (LINE_W_ACTIVE[item.level] ?? 18) : (LINE_W[item.level] ?? 10)
        return (
          <button
            type="button"
            key={item.id}
            data-toc-id={item.id}
            data-level={item.level}
            className={cn("ftoc-item", active && "is-active")}
            onClick={() => handleClick(item.id)}
          >
            <span className="ftoc-text">{item.text}</span>
            <span className="ftoc-line" style={{ width: w }} />
          </button>
        )
      })}
    </nav>,
    document.body
  )
}

/* ─── Back to top ────────────────────────────────────────── */

export function BackToTopButton() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // portal so position:fixed is relative to viewport, not SidebarInset (overflow:hidden)
  return createPortal(
    <button
      aria-label="返回顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-50 size-9 flex items-center justify-center",
        "rounded-full border bg-background/80 backdrop-blur-sm shadow-md",
        "transition-[opacity,transform,background-color,box-shadow] duration-300 hover:bg-background hover:shadow-lg",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-3 pointer-events-none"
      )}
    >
      <ChevronUp className="size-4" />
    </button>,
    document.body
  )
}
