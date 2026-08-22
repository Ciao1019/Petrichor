"use client"

import * as React from "react"
import { ArrowLeft, BookOpen, ExternalLink, FileText, Loader2 } from "@/components/iconimate"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { MarkdownPreview } from "@/components/markdown/MarkdownPreview"
import { wikiScribbleStyle } from "@/components/markdown/wiki-scribble"
import { publicWikiApi, type PublicWikiPageDetail } from "@/lib/api"
import {
  prepareWikiMarkdown,
  type WikiMarkdownLinkTarget,
} from "@/features/pages/knowledge/knowledge-wiki-markdown"

const KIND_LABEL: Record<string, string> = {
  index: "Wiki 索引",
  source: "文章摘要",
  entity: "实体",
  concept: "概念",
  comparison: "对比",
  answer: "答案",
}

/** 页面详情加载器：公开问答用 publicWikiApi，后台助手传 assistantWikiApi 的包装。 */
export type WikiPageDetailLoader = (pageKey: string) => Promise<PublicWikiPageDetail>

function resolveApiErrorMessage(error: unknown, fallback: string) {
  const data = (error as { response?: { data?: { msg?: unknown } } })?.response?.data
  return typeof data?.msg === "string" && data.msg.trim() ? data.msg : fallback
}

/**
 * Wiki 页面预览弹窗：点击回答里的波浪线 Wiki 引用时打开（公开问答与后台助手共用）。
 * 弹窗内可以继续点页面里的内链跳到关联页面，带返回栈；底部可跳来源文档。
 */
export function WikiPagePreviewDialog({
  pageKey,
  onClose,
  loadDetail,
}: {
  pageKey: string | null
  onClose: () => void
  /** 缺省走公开接口；后台助手传 assistantWikiApi.detail。 */
  loadDetail?: WikiPageDetailLoader
}) {
  const loader = loadDetail ?? ((key: string) => publicWikiApi.detail(key).then((res) => res.data))
  // 弹窗内部导航栈：点内链时压栈，支持逐级返回。
  const [history, setHistory] = React.useState<string[]>([])
  const [activePageKey, setActivePageKey] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<PublicWikiPageDetail | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const requestRef = React.useRef(0)

  React.useEffect(() => {
    setActivePageKey(pageKey)
    setHistory([])
  }, [pageKey])

  React.useEffect(() => {
    if (!activePageKey || !pageKey) return
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    loader(activePageKey)
      .then((data) => {
        if (requestRef.current !== requestId) return
        setDetail(data)
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== requestId) return
        setDetail(null)
        setError(resolveApiErrorMessage(cause, "无法加载该 Wiki 页面。"))
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false)
      })
  }, [activePageKey, pageKey, loader])

  // 关闭弹窗时清空缓存内容，避免下次打开闪现旧页面。
  React.useEffect(() => {
    if (pageKey) return
    requestRef.current += 1
    setDetail(null)
    setError(null)
    setLoading(false)
    setActivePageKey(null)
    setHistory([])
  }, [pageKey])

  const openInDialog = React.useCallback((nextPageKey: string) => {
    if (!nextPageKey || nextPageKey === activePageKey) return
    if (activePageKey) {
      setHistory((stack) => [...stack, activePageKey])
    }
    setActivePageKey(nextPageKey)
  }, [activePageKey])

  const goBack = React.useCallback(() => {
    const previous = history[history.length - 1]
    if (!previous) return
    setHistory((stack) => stack.slice(0, -1))
    setActivePageKey(previous)
  }, [history])

  const handleMarkdownClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const anchor = target.closest("a")
    const href = anchor?.getAttribute("href") ?? ""
    if (!href.startsWith("#wiki-page=")) return
    event.preventDefault()
    try {
      openInDialog(decodeURIComponent(href.slice("#wiki-page=".length)))
    } catch {
      openInDialog(href.slice("#wiki-page=".length))
    }
  }, [openInDialog])

  const relatedTargets: WikiMarkdownLinkTarget[] = React.useMemo(() => {
    if (!detail) return []
    return [
      ...detail.links.map((link) => ({ pageKey: link.pageKey, title: link.title })),
      ...detail.inLinks.map((link) => ({ pageKey: link.pageKey, title: link.title })),
    ]
  }, [detail])

  const resolvePageTitle = React.useCallback(
    (key: string) => relatedTargets.find((target) => target.pageKey === key)?.title ?? null,
    [relatedTargets],
  )

  const markdownValue = React.useMemo(() => (
    detail ? prepareWikiMarkdown(detail.contentMd, detail.title, relatedTargets, resolvePageTitle) : ""
  ), [detail, relatedTargets, resolvePageTitle])

  return (
    <ModalShell
      open={Boolean(pageKey)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <BookOpen className="size-5 shrink-0 text-primary" />
          <span className="truncate">{detail?.title ?? "Wiki 页面"}</span>
        </span>
      }
      description={detail?.summary || undefined}
      contentClassName="sm:max-w-2xl lg:max-w-3xl"
      bodyClassName="bg-card"
      footer={
        detail && detail.sourceArticles.length > 0 ? (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">来源文档</span>
            {detail.sourceArticles.map((article) => (
              <Button key={article.articleId} variant="outline" size="sm" asChild>
                <a href={article.href} target="_blank" rel="noreferrer">
                  <FileText className="size-3.5" />
                  <span className="max-w-48 truncate">{article.title}</span>
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            ))}
          </div>
        ) : undefined
      }
    >
      {detail ? (
        <div className="px-1 pb-2">
          <div className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="flex flex-wrap items-center gap-2">
              {history.length > 0 ? (
                <Button variant="ghost" size="sm" className="-ml-2 h-8" onClick={goBack}>
                  <ArrowLeft className="size-4" />
                  返回
                </Button>
              ) : null}
              <Badge variant="secondary">{KIND_LABEL[detail.kind] ?? detail.kind}</Badge>
              {detail.aliases.map((alias) => (
                <Badge key={alias} variant="outline">{alias}</Badge>
              ))}
            </div>
          </div>
          <div onClick={handleMarkdownClick} className="text-[15px]">
            <MarkdownPreview value={markdownValue} variant="typography" />
          </div>
          {(detail.links.length > 0 || detail.inLinks.length > 0) ? (
            <section className="mt-8 space-y-4 border-t pt-4 text-sm">
              {[
                { label: "关联知识", items: detail.links },
                { label: "被引用", items: detail.inLinks },
              ].map((group) => group.items.length === 0 ? null : (
                <div key={group.label} className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                  <span className="shrink-0 pt-0.5 text-muted-foreground sm:w-16">{group.label}</span>
                  <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-2">
                    {group.items.map((item) => (
                      <button
                        key={`${group.label}-${item.pageKey}`}
                        type="button"
                        title={item.summary || undefined}
                        className="cursor-pointer text-left font-medium transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        style={wikiScribbleStyle(item.pageKey)}
                        onClick={() => openInDialog(item.pageKey)}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      ) : loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在加载 Wiki 页面…
        </div>
      ) : error ? (
        <div className="flex min-h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {error}
        </div>
      ) : null}
    </ModalShell>
  )
}

export default WikiPagePreviewDialog
