import type { MindElixirData } from "mind-elixir"
import * as React from "react"
import { List, Loader2, X } from "lucide-react"
import { Suspense, useMemo } from "react"

import { PlateMarkdownPreview } from "@/components/plate/PlateMarkdownPreview"
import { cn } from "@/lib/utils"
import type { TocItem } from "@/features/pages/public/public-article-utils"

type PublicArticlePanelProps = {
  contentJson?: string | null
  contentMetaJson?: string | null
  contentMd: string
  toc: TocItem[]
  activeHeadingId: string
  onTocClick: (id: string) => void
}

const TOC_MIN_LEVEL = 2
const TOC_MAX_LEVEL = 4

/** 按标题层级设置默认与激活态横线宽度 */
const LINE_W: Record<number, number> = { 2: 14, 3: 10, 4: 7 }
const LINE_W_ACTIVE: Record<number, number> = { 2: 22, 3: 18, 4: 13 }

function PublicArticleFloatingToc({
  navToc,
  activeHeadingId,
  onTocClick,
}: {
  navToc: TocItem[]
  activeHeadingId: string
  onTocClick: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLElement | null>(null)
  const clickLockRef = React.useRef(false)

  /* 自动滚动目录容器，让激活项保持可见；点击触发正文滚动时暂时跳过，避免抖动。 */
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
    /* 先把目录容器滚到目标项附近，再锁定自动滚动。 */
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
    /* 等正文平滑滚动结束后再恢复自动滚动。 */
    setTimeout(() => { clickLockRef.current = false }, 900)
  }, [onTocClick])

  return (
    <nav className="ftoc" ref={containerRef} aria-label="目录">
      {navToc.map((item) => {
        const active = activeHeadingId === item.id
        const w = active ? (LINE_W_ACTIVE[item.level] ?? 18) : (LINE_W[item.level] ?? 10)
        return (
          <div
            key={item.id}
            data-toc-id={item.id}
            data-level={item.level}
            className={cn("ftoc-item", active && "is-active")}
            onClick={() => handleClick(item.id)}
          >
            <span className="ftoc-text">{item.text}</span>
            <span className="ftoc-line" style={{ width: w }} />
          </div>
        )
      })}
    </nav>
  )
}

function MobileTocDrawer({
  open,
  onClose,
  navToc,
  activeHeadingId,
  onTocClick,
}: {
  open: boolean
  onClose: () => void
  navToc: TocItem[]
  activeHeadingId: string
  onTocClick: (id: string) => void
}) {
  return (
    <div className="lg:hidden">
      {/* 遮罩层 */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-blue-950/55 transition-opacity duration-300",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
      />
      {/* 底部目录抽屉 */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-50 flex max-h-[72vh] flex-col",
          "rounded-t-2xl border-t border-white/15 bg-[#0044cc]/95 text-white backdrop-blur-xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="text-sm font-semibold">目录</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 transition-colors hover:bg-white/10"
            aria-label="关闭目录"
          >
            <X className="size-4" />
          </button>
        </div>
        <nav className="overflow-y-auto px-2 py-2 pb-6">
          {navToc.map((item) => {
            const active = activeHeadingId === item.id
            return (
              <button
                key={item.id}
                onClick={() => { onTocClick(item.id); onClose() }}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  item.level === 3 && "pl-7",
                  item.level === 4 && "pl-11",
                  active
                    ? "bg-yellow-300 font-semibold text-blue-950"
                    : "text-white/75 hover:bg-white/10 hover:text-white",
                )}
              >
                {item.text}
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}

export function PublicArticlePanel({
  contentJson,
  contentMetaJson,
  contentMd,
  toc,
  activeHeadingId,
  onTocClick,
}: PublicArticlePanelProps) {
  const navToc = React.useMemo(() => toc.filter((item) => item.level >= TOC_MIN_LEVEL && item.level <= TOC_MAX_LEVEL), [toc])
  const [mobileTocOpen, setMobileTocOpen] = React.useState(false)

  return (
    <>
      <PlateMarkdownPreview
        contentJson={contentJson}
        contentMetaJson={contentMetaJson}
        markdown={contentMd}
        headings={toc}
        className="mx-auto max-w-none"
        publicMediaAccess
      />
      {navToc.length > 0 ? (
        <>
          <PublicArticleFloatingToc navToc={navToc} activeHeadingId={activeHeadingId} onTocClick={onTocClick} />
          {/* 小屏目录入口；桌面端保留侧边浮动目录。 */}
          <button
            aria-label="打开目录"
            onClick={() => setMobileTocOpen(true)}
            className={cn(
              "public-article-mobile-toc-trigger fixed bottom-6 left-6 z-50 flex h-9 items-center gap-1.5 rounded-full border",
              "border-white/20 bg-[#0044cc]/90 px-3 text-sm font-medium text-white shadow-md backdrop-blur-sm",
              "transition-[background-color,color,box-shadow] duration-300 hover:bg-yellow-300 hover:text-blue-950 hover:shadow-lg",
              "lg:hidden",
            )}
          >
            <List className="size-4" />
            <span>目录</span>
          </button>
          <MobileTocDrawer
            open={mobileTocOpen}
            onClose={() => setMobileTocOpen(false)}
            navToc={navToc}
            activeHeadingId={activeHeadingId}
            onTocClick={onTocClick}
          />
        </>
      ) : null}
    </>
  )
}

type PublicMindmapPanelProps = {
  data: MindElixirData | null
  loading: boolean
}

function PublicMindmapLoadingState() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      role="status"
      aria-label="思维导图加载状态"
    >
      <Loader2 className="size-7 animate-spin text-slate-400" aria-hidden="true" />
    </div>
  )
}

export function PublicMindmapPanel({ data, loading }: PublicMindmapPanelProps) {
  const LazyMindMap = useMemo(
    () =>
      React.lazy(async () => {
        const module = await import("@/components/ui/mindmap-runtime")
        return { default: module.MindMap }
      }),
    [],
  )
  const LazyMindMapControls = useMemo(
    () =>
      React.lazy(async () => {
        const module = await import("@/components/ui/mindmap-runtime")
        return { default: module.MindMapControls }
      }),
    [],
  )

  return (
    <div className="space-y-2">
      <div className={cn("relative h-[calc(100vh-240px)] min-h-[28rem] w-full overflow-hidden rounded-lg border border-white/20 bg-white text-slate-950")}>
        {data ? (
          <Suspense fallback={<PublicMindmapLoadingState />}>
            <LazyMindMap data={data} readonly fit locale="zh_CN">
              <LazyMindMapControls position="top-right" />
            </LazyMindMap>
          </Suspense>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {loading ? <PublicMindmapLoadingState /> : "暂无数据"}
          </div>
        )}
      </div>
    </div>
  )
}
