"use client"

import * as React from "react"
import { ArrowUpRight, BookOpen, Loader2 } from "@/components/iconimate"

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import type { PublicWikiPageDetail } from "@/lib/api"
import { wikiScribbleStyle } from "@/components/markdown/wiki-scribble"

/** 从 #wiki-page=<encoded> 链接里解出 pageKey；非该类链接返回 null。 */
export function readWikiPageKeyFromHref(href: string | undefined | null): string | null {
  if (typeof href !== "string" || !href.startsWith("#wiki-page=")) return null
  try {
    return decodeURIComponent(href.slice("#wiki-page=".length)) || null
  } catch {
    return null
  }
}

/** 页面详情加载器：公开问答用 publicWikiApi 包装，后台助手用 assistantWikiApi 包装。 */
export type WikiPageDetailLoader = (pageKey: string) => Promise<PublicWikiPageDetail>

/** Wiki 页面类型的中文名，悬停小卡与完整弹窗共用。 */
export const WIKI_KIND_LABEL: Record<string, string> = {
  index: "Wiki 索引",
  source: "文章摘要",
  entity: "实体",
  concept: "概念",
  comparison: "对比",
  answer: "答案",
}

/**
 * Wiki 内链运行时：注册后回答里的 [[..]] 引用会渲染成带手绘波浪线的链接，
 * 点击交给调用方（通常是打开 Wiki 弹窗）；同时提供悬停预览卡的取数器。
 */
type WikiLinkRuntime = {
  onOpenWikiPage: ((pageKey: string) => void) | null
  previewLoader: WikiPageDetailLoader | null
}

const WikiLinkRuntimeContext = React.createContext<WikiLinkRuntime>({
  onOpenWikiPage: null,
  previewLoader: null,
})

export function WikiLinkClickProvider({
  onOpenWikiPage,
  previewLoader,
  children,
}: {
  onOpenWikiPage: (pageKey: string) => void
  /** 悬停预览卡的取数器；不传则内链只有点击行为、不显示预览卡。 */
  previewLoader?: WikiPageDetailLoader
  children: React.ReactNode
}) {
  const runtime = React.useMemo<WikiLinkRuntime>(
    () => ({ onOpenWikiPage, previewLoader: previewLoader ?? null }),
    [onOpenWikiPage, previewLoader],
  )
  return <WikiLinkRuntimeContext.Provider value={runtime}>{children}</WikiLinkRuntimeContext.Provider>
}

export function useOpenWikiPage() {
  return React.useContext(WikiLinkRuntimeContext).onOpenWikiPage
}

/** 悬停预览的详情缓存：按 loader 分桶（公开/助手各一套），同一页面只拉一次。 */
const previewCache = new WeakMap<WikiPageDetailLoader, Map<string, Promise<PublicWikiPageDetail>>>()

function loadWikiPreviewCached(loader: WikiPageDetailLoader, pageKey: string) {
  let bucket = previewCache.get(loader)
  if (!bucket) {
    bucket = new Map()
    previewCache.set(loader, bucket)
  }
  const store = bucket
  const cached = store.get(pageKey)
  if (cached) return cached
  // 失败不进缓存：下次悬停还能重试。
  const request = loader(pageKey).catch((cause: unknown) => {
    store.delete(pageKey)
    throw cause
  })
  store.set(pageKey, request)
  return request
}

/**
 * Wikipedia 式的 Wiki 内链：平时就是带马克笔波浪线的链接，
 * 悬停片刻浮出小预览卡（类型 + 标题 + 摘要），点击才打开完整弹窗。
 * 未注册点击回调或预览取数器时退化为普通链接。
 */
export function WikiPreviewLink({
  pageKey,
  href,
  className,
  style,
  children,
  ...rest
}: React.ComponentProps<"a"> & { pageKey: string }) {
  const { onOpenWikiPage, previewLoader } = React.useContext(WikiLinkRuntimeContext)
  const enabled = Boolean(onOpenWikiPage && previewLoader)
  const [open, setOpen] = React.useState(false)
  const [detail, setDetail] = React.useState<PublicWikiPageDetail | null>(null)
  const [failed, setFailed] = React.useState(false)

  // 卡片首次展开才取数；命中模块缓存时立即渲染。
  React.useEffect(() => {
    if (!enabled || !open || !previewLoader || detail || failed) return
    let canceled = false
    loadWikiPreviewCached(previewLoader, pageKey)
      .then((data) => {
        if (!canceled) setDetail(data)
      })
      .catch(() => {
        if (!canceled) setFailed(true)
      })
    return () => {
      canceled = true
    }
  }, [enabled, open, previewLoader, pageKey, detail, failed])

  const anchor = (
    <a
      {...rest}
      href={href}
      className={className ?? "cursor-pointer font-medium underline-offset-4 hover:opacity-80"}
      // 有预览卡时提示交给卡片本身；退化场景保留原来的 title 提示。
      title={enabled ? undefined : "点击查看 Wiki 页面"}
      onClick={(event) => {
        event.preventDefault()
        onOpenWikiPage?.(pageKey)
      }}
      style={{ ...wikiScribbleStyle(pageKey), ...style }}
    >
      {children}
    </a>
  )

  if (!enabled) return anchor

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>{anchor}</HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80 rounded-xl p-0 shadow-xl">
        {detail ? (
          <div className="flex flex-col gap-2 p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10">
                <BookOpen className="size-3 text-primary" />
              </span>
              Wiki · {WIKI_KIND_LABEL[detail.kind] ?? detail.kind}
            </div>
            <p className="text-sm font-semibold leading-snug text-pretty">{detail.title}</p>
            {detail.summary ? (
              <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                {detail.summary}
              </p>
            ) : null}
            <div className="mt-1 flex items-center gap-1 border-t pt-2 text-[11px] text-muted-foreground/80">
              点击查看完整内容
              <ArrowUpRight className="size-3" />
            </div>
          </div>
        ) : failed ? (
          <p className="p-4 text-xs leading-relaxed text-muted-foreground">暂时无法加载该页面的预览。</p>
        ) : (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在加载预览…
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * 回答正文里的 Wiki 内链：去系统下划线，描一道按 pageKey 稳定取色的
 * 手绘马克笔波浪（与知识库「知识关联」视觉一致），点击交给弹窗，
 * 悬停展示 Wikipedia 式预览小卡。
 * 供 assistant-ui MarkdownTextPrimitive 与 LobeHub Markdown 两套渲染管线复用。
 */
export function WikiScribbleAnchor(props: React.ComponentProps<"a"> & { node?: unknown }) {
  const { href, children, style, node, className, ...rest } = props
  void node
  const pageKey = readWikiPageKeyFromHref(href)
  if (!pageKey) return null
  return (
    <WikiPreviewLink pageKey={pageKey} href={href} className={className} style={style} {...rest}>
      {children}
    </WikiPreviewLink>
  )
}
