"use client"

import * as React from "react"
import {
  Clock,
  List,
  RefreshCw,
  Sparkles,
  Tags,
} from "@/components/iconimate"
import { Link, useParams } from "react-router-dom"

import { wikiScribbleStyle } from "@/components/markdown/wiki-scribble"
import { PlateMarkdownPreview } from "@/components/plate/PlateMarkdownPreview"
import { preparePublicWikiMarkdown } from "@/features/pages/knowledge/knowledge-wiki-markdown"
import {
  MobileTocDrawer,
  PublicArticleFloatingToc,
} from "@/features/pages/public/PublicArticlePanels"
import { buildToc, scrollToHeading } from "@/features/pages/public/public-article-utils"
import { usePublicArticleActiveHeading } from "@/features/pages/public/usePublicArticleActiveHeading"
import { publicWikiApi, type PublicWikiPageDetail } from "@/lib/api"
import { cn } from "@/lib/utils"
import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import {
  PublicWikiStatus,
  resolvePublicWikiError,
} from "./PublicWikiLayout"
import { PublicWikiLoading } from "./PublicWikiLoading"
import { formatWikiDate, wikiKindConfig } from "./public-wiki-presentation"

function WikiDetailContent({ detail }: { detail: PublicWikiPageDetail }) {
  const markdown = React.useMemo(() => {
    const targets = [...detail.links, ...detail.inLinks]
      .filter((item, index, values) => values.findIndex((candidate) => candidate.pageKey === item.pageKey) === index)
      .map((item) => ({ pageKey: item.pageKey, title: item.title }))
    return preparePublicWikiMarkdown(detail.contentMd, detail.title, detail.knowledgeBaseId, targets)
  }, [detail])

  const tocAll = React.useMemo(() => buildToc(markdown), [markdown])
  const navToc = React.useMemo(
    () => tocAll.filter((item) => item.level >= 2 && item.level <= 4),
    [tocAll],
  )
  const [mobileTocOpen, setMobileTocOpen] = React.useState(false)
  const { activeHeadingId, setActiveHeadingId } = usePublicArticleActiveHeading({
    tab: "article",
    navToc,
    scrollOffsetPx: 48,
  })

  const handleTocClick = React.useCallback(
    (id: string, behavior?: ScrollBehavior) => {
      scrollToHeading(id, behavior)
      setActiveHeadingId(id)
    },
    [setActiveHeadingId],
  )

  const kindConfig = wikiKindConfig[detail.kind]
  const KindIcon = kindConfig?.icon || Tags

  return (
    <div className="public-article--retypeset space-y-8">
      {/* 头部元信息与标题 */}
      <header className="space-y-3.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${
              kindConfig?.badgeClass || "border-white/15 bg-white/10 text-white/80"
            }`}
          >
            <KindIcon className="size-3" />
            {kindConfig?.label || detail.kind}
          </span>
          {detail.categoryPath.length > 0 ? (
            <span className="break-words text-white/45">
              {detail.categoryPath.join(" / ")}
            </span>
          ) : null}
          <span className="text-white/30">·</span>
          <span className="inline-flex items-center gap-1 text-white/45">
            <Clock className="size-3 opacity-60" />
            更新于 {formatWikiDate(detail.updatedAt)}
          </span>
        </div>

        <h1 className="break-words text-2xl font-bold tracking-tight text-white sm:text-3xl lg:text-4xl">
          {detail.title}
        </h1>

        {/* 别名微标签群 */}
        {detail.aliases.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-white/60">
            <span className="text-white/40">别名：</span>
            {detail.aliases.map((alias) => (
              <span
                key={alias}
                className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/70"
              >
                {alias}
              </span>
            ))}
          </div>
        ) : null}

        {/* 核心导读卡片 */}
        {detail.summary ? (
          <div className="relative mt-4 overflow-hidden rounded-xl border border-white/15 bg-white/[0.03] p-4.5 backdrop-blur-xs">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white/75">
              <Sparkles className="size-3.5 text-yellow-300/80" />
              导读摘要
            </div>
            <p className="mt-2 text-sm leading-relaxed text-white/80">
              {detail.summary}
            </p>
          </div>
        ) : null}
      </header>

      {/* 正文 Markdown 区域 */}
      <article className="public-article public-article--retypeset min-w-0 rounded-2xl border border-white/[0.08] bg-white/[0.015] p-6 sm:p-8">
        <PlateMarkdownPreview
          markdown={markdown}
          headings={tocAll}
          publicMediaAccess
          publicMediaAccessToken={detail.mediaAccessToken}
        />
      </article>

      {/* 关联知识、被引用与来源文档 */}
      {(detail.links.length > 0 || detail.inLinks.length > 0 || detail.sourceArticles.length > 0) ? (
        <section className="mt-10 border-t border-white/[0.08] pt-6 text-sm">
          <dl className="space-y-4 sm:space-y-5">
            {[
              { label: "关联知识", items: detail.links },
              { label: "被引用", items: detail.inLinks },
            ].map((group) => group.items.length === 0 ? null : (
              <div key={group.label} className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                <dt className="shrink-0 pt-0.5 text-xs font-semibold text-white/45 sm:w-20 sm:text-sm">
                  {group.label}
                </dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3.5 text-sm">
                  {group.items.map((item) => (
                    <Link
                      key={`${group.label}-${item.pageKey}-${item.linkType}`}
                      to={item.href || `#wiki-page=${encodeURIComponent(item.pageKey)}`}
                      title={item.summary || undefined}
                      className="min-w-0 break-words cursor-pointer font-medium text-white/85 no-underline transition-colors hover:text-white"
                      style={{ ...wikiScribbleStyle(item.pageKey), textDecoration: "none" }}
                    >
                      {item.title}
                    </Link>
                  ))}
                </dd>
              </div>
            ))}

            {/* 来源文档 */}
            {detail.sourceArticles.length > 0 ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                <dt className="shrink-0 pt-0.5 text-xs font-semibold text-white/45 sm:w-20 sm:text-sm">
                  来源文档
                </dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3.5 text-sm">
                  {detail.sourceArticles.map((article) => (
                    <Link
                      key={article.articleId}
                      to={article.href}
                      title={article.note || undefined}
                      className="min-w-0 break-words cursor-pointer font-medium text-white/85 no-underline transition-colors hover:text-white"
                      style={{ ...wikiScribbleStyle(article.articleId), textDecoration: "none" }}
                    >
                      {article.title}
                    </Link>
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      {/* 浮动大纲（桌面端右侧线条 + 展开浮动卡片；移动端左下角悬浮按钮 + 抽屉） */}
      {navToc.length > 0 ? (
        <>
          <PublicArticleFloatingToc
            navToc={navToc}
            activeHeadingId={activeHeadingId}
            onTocClick={handleTocClick}
          />
          <button
            type="button"
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
            onTocClick={handleTocClick}
          />
        </>
      ) : null}
    </div>
  )
}

export function PublicWikiPage() {
  const { knowledgeBaseId = "", pageKey = "" } = useParams()
  const [detail, setDetail] = React.useState<PublicWikiPageDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  usePublicPageMeta(
    `${detail?.title || "知识页"} · Petrichor Wiki`,
    detail?.summary || "阅读公开 Wiki 知识页、关联页面与来源文章。",
    `/wiki/${encodeURIComponent(knowledgeBaseId)}/${encodeURIComponent(pageKey)}`,
  )

  const load = React.useCallback(async (isCanceled: () => boolean = () => false) => {
    if (!knowledgeBaseId || !pageKey) return
    setLoading(true)
    setError(null)
    try {
      const response = await publicWikiApi.detail(pageKey, knowledgeBaseId)
      if (!isCanceled()) setDetail(response.data)
    } catch (loadError) {
      if (!isCanceled()) {
        setDetail(null)
        setError(resolvePublicWikiError(loadError, "Wiki 页面加载失败"))
      }
    } finally {
      if (!isCanceled()) setLoading(false)
    }
  }, [knowledgeBaseId, pageKey])

  React.useEffect(() => {
    let canceled = false
    void load(() => canceled)
    return () => { canceled = true }
  }, [load])

  return (
    <div>
      {loading ? (
        <PublicWikiLoading />
      ) : error || !detail ? (
        <PublicWikiStatus
          icon={<RefreshCw className="size-5 text-white/70" />}
          title="无法打开这个 Wiki 页面"
          detail={error}
          action={
            <div className="flex justify-center gap-3 text-xs">
              <Link
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-4 py-1.5 font-medium text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                to="/wiki"
              >
                返回 Wiki
              </Link>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-4 py-1.5 font-semibold text-white transition-colors hover:bg-white/20"
                onClick={() => void load()}
              >
                <RefreshCw className="size-3.5" />
                重试
              </button>
            </div>
          }
        />
      ) : (
        <WikiDetailContent detail={detail} />
      )}
    </div>
  )
}
