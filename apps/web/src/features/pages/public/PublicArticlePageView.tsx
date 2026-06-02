import { useState, useEffect, type Ref } from "react"
import type { MindElixirData } from "mind-elixir"
import { ChevronUp } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PixelFlowerLayer, type PixelFlowerDecoration } from "@/features/pages/blog/PixelDecorations"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { PublicArticleErrorCard, PublicArticlePasswordCard } from "@/features/pages/public/PublicArticleChrome"
import { PublicArticlePanel, PublicMindmapPanel } from "@/features/pages/public/PublicArticlePanels"
import {
  shouldRenderPublicArticleBody,
  shouldShowPublicArticleLoadingCard,
} from "@/features/pages/public/public-article-render-state"
import type { TocItem } from "@/features/pages/public/public-article-utils"
import { cn } from "@/lib/utils"

export type PublicArticlePageModel = {
  shareCode: string | undefined
  shareUrl: string
  hasArticleData: boolean
  loading: boolean
  error: string | null
  needPassword: boolean
  passwordId: string
  accessPassword: string
  onAccessPasswordChange: (next: string) => void
  onSubmitPassword: () => void
  articleRef: Ref<HTMLElement>
  title: string
  tags: string[] | null | undefined
  createdAt: string | null | undefined
  updatedAt: string | null | undefined
  aiSummary: string | null
  coverImageUrl: string | null
  repostSource: PublicArticleRepostSource | null
  tab: "article" | "mindmap"
  onTabChange: (tab: "article" | "mindmap") => void
  contentMd: string
  contentJson?: string | null
  contentMetaJson?: string | null
  tocAll: TocItem[]
  activeHeadingId: string
  onTocClick: (id: string) => void
  mindmapData: MindElixirData | null
}

export type PublicArticleRepostSource = {
  originalUrl: string
  originalAuthorName: string
}

const articleDetailBackgroundFlowers: PixelFlowerDecoration[] = [
  {
    className: "left-[5%] top-[9%] size-10 opacity-30 sm:size-12",
    tone: "red",
    animationClassName: "blog-float-medium",
  },
  {
    className: "right-[6%] top-[24%] hidden size-12 opacity-35 md:block",
    tone: "yellow",
    animationClassName: "blog-float-slow blog-delay-500",
  },
  {
    className: "bottom-[14%] left-[8%] hidden size-8 opacity-30 sm:block",
    tone: "yellow",
    animationClassName: "blog-float-fast blog-delay-300",
  },
  {
    className: "bottom-[10%] right-[7%] size-10 opacity-30 md:size-14",
    tone: "red",
    tall: true,
    animationClassName: "blog-float-medium blog-delay-700",
  },
]

export function PublicArticlePageView({ model }: { model: PublicArticlePageModel }) {
  const renderState = {
    hasArticleData: model.hasArticleData,
    loading: model.loading,
    error: model.error,
    needPassword: model.needPassword,
  }
  const showLoadingCard = shouldShowPublicArticleLoadingCard(renderState)
  const showArticleBody = shouldRenderPublicArticleBody(renderState)

  return (
    <main className="retypeset-home scrollbar-hide relative flex min-h-screen flex-col overflow-x-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
      <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
      <PixelFlowerLayer
        flowers={articleDetailBackgroundFlowers}
        className="fixed inset-0 z-0 overflow-hidden"
        flowerClassName="drop-shadow-lg"
      />

      <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-8 lg:contents">
        <RetypesetSiteHeader dockVisible />
        <RetypesetSiteNav activeSection="articles" dockVisible />
      </div>

      <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-10 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:my-20 lg:max-w-[min(calc(75vw-16rem),44rem)] lg:p-0">
        {model.error && !model.needPassword ? <PublicArticleErrorCard error={model.error} /> : null}
        {model.needPassword ? (
          <PublicArticlePasswordCard
            passwordId={model.passwordId}
            accessPassword={model.accessPassword}
            loading={model.loading}
            error={model.error}
            onAccessPasswordChange={model.onAccessPasswordChange}
            onSubmit={model.onSubmitPassword}
          />
        ) : null}
        {showLoadingCard ? <PublicArticleLoadingCard /> : null}
        {showArticleBody ? <PublicArticleBody model={model} /> : null}
      </section>

      <div className="relative z-30 mx-auto mt-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pb-8 lg:contents">
        <RetypesetSiteFooter dockVisible />
      </div>

      <BackToTopButton />
    </main>
  )
}

function PublicArticleLoadingCard() {
  return (
    <div className="public-article public-article--retypeset animate-in fade-in-0 duration-300">
      {/* 标题骨架 */}
      <div className="post-header">
        <div className="skeleton-bar h-9 w-3/5 md:h-10" />
        <div className="mt-3 flex items-center gap-3">
          <div className="skeleton-bar h-4 w-24" />
          <div className="skeleton-bar h-4 w-32" />
        </div>
      </div>
      {/* 标签页骨架 */}
      <div className="mb-6 flex gap-1">
        <div className="skeleton-bar h-8 w-14 rounded-md" />
        <div className="skeleton-bar h-8 w-18 rounded-md" />
      </div>
      {/* 正文骨架 */}
      <div className="space-y-5">
        <div className="skeleton-bar h-3.5 w-full" />
        <div className="skeleton-bar h-3.5 w-11/12" />
        <div className="skeleton-bar h-3.5 w-4/5" />
        <div className="mt-8 h-px w-full" />
        <div className="skeleton-bar h-3.5 w-full" />
        <div className="skeleton-bar h-3.5 w-3/4" />
        <div className="skeleton-bar h-3.5 w-5/6" />
        <div className="skeleton-bar h-3.5 w-2/3" />
      </div>
    </div>
  )
}

function PublicArticleBody({ model }: { model: PublicArticlePageModel }) {
  const { articleRef, title, tags, createdAt, updatedAt, tab, onTabChange } = model
  const [mindmapMounted, setMindmapMounted] = useState(tab === "mindmap")

  const handleTabChange = (nextTab: PublicArticlePageModel["tab"]) => {
    if (nextTab === "mindmap") setMindmapMounted(true)
    onTabChange(nextTab)
  }

  return (
    <article ref={articleRef} className="public-article public-article--retypeset">
      <PublicArticleRepostAttribution source={model.repostSource} />
      <PublicArticleTitleSection title={title} createdAt={createdAt} updatedAt={updatedAt} />
      <PublicArticleAiSummary summary={model.aiSummary} />
      <PublicArticleTabs tab={tab} onTabChange={handleTabChange} />
      <PublicArticleTabPanels
        model={model}
        mindmapMounted={mindmapMounted || tab === "mindmap"}
      />
      <PublicArticleTagsFooter tags={tags} />
    </article>
  )
}

function PublicArticleRepostAttribution({ source }: { source: PublicArticleRepostSource | null }) {
  if (!source) return null

  return (
    <aside className="post-repost-source" aria-label="转载来源">
      <span className="post-repost-label">转载</span>
      <span className="post-repost-author">
        原作者 <strong>{source.originalAuthorName}</strong>
      </span>
      <a
        className="post-repost-link"
        href={source.originalUrl}
        target="_blank"
        rel="noreferrer noopener"
        title={source.originalUrl}
        aria-label={`在新窗口打开原作者 ${source.originalAuthorName} 的原文链接`}
      >
        原文链接
      </a>
    </aside>
  )
}

function PublicArticleAiSummary({ summary }: { summary: string | null }) {
  const displayText = useTypewriterText(summary ?? "")
  if (!summary?.trim()) return null
  const normalizedSummary = summary.trim()

  return (
    <section className="post-ai-summary" aria-label="AI 总结">
      <div className="post-ai-summary-label">AI 总结</div>
      <p className="post-ai-summary-text">
        <span className="invisible block" aria-hidden="true">{normalizedSummary}</span>
        <span className="absolute inset-0">
          {displayText}
          <span
            className="post-ai-summary-caret"
            aria-hidden="true"
            data-done={displayText.length >= normalizedSummary.length}
          />
        </span>
      </p>
    </section>
  )
}

function useTypewriterText(value: string) {
  const [displayText, setDisplayText] = useState("")

  useEffect(() => {
    const text = value.trim()
    if (!text) {
      setDisplayText("")
      return
    }
    const characters = Array.from(text)
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (prefersReducedMotion) {
      setDisplayText(text)
      return
    }

    let index = 1
    setDisplayText("")
    setDisplayText(characters.slice(0, index).join(""))
    if (characters.length <= 1) {
      return
    }

    const timer = window.setInterval(() => {
      index = Math.min(index + 1, characters.length)
      setDisplayText(characters.slice(0, index).join(""))
      if (index >= characters.length) {
        window.clearInterval(timer)
      }
    }, 46)

    return () => {
      window.clearInterval(timer)
    }
  }, [value])

  return displayText
}

function PublicArticleTitleSection({
  title,
  createdAt,
  updatedAt,
}: {
  title: string
  createdAt: string | null | undefined
  updatedAt: string | null | undefined
}) {
  const showUpdated = updatedAt && updatedAt !== createdAt
  return (
    <header className="post-header">
      <h1 className="post-title">{title}</h1>
      {(createdAt || updatedAt) ? (
        <div className="post-date">
          {createdAt ? <time>{createdAt}</time> : null}
          {showUpdated ? (
            <span className="post-date-updated">
              <span className="post-date-sep">·</span>
              已更新 {updatedAt}
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}

function PublicArticleTagsFooter({ tags }: { tags: string[] | null | undefined }) {
  if (!Array.isArray(tags) || tags.length === 0) return null
  return (
    <footer className="post-tags-footer">
      <div className="post-tags-line" />
      <div className="post-tags">
        {tags.map((tag) => (
          <Badge key={tag} variant="outline" className="post-tag">
            {tag}
          </Badge>
        ))}
      </div>
    </footer>
  )
}

function PublicArticleTabs({
  tab,
  onTabChange,
}: {
  tab: PublicArticlePageModel["tab"]
  onTabChange: PublicArticlePageModel["onTabChange"]
}) {
  return (
    <div className="mb-6">
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as PublicArticlePageModel["tab"])}>
        <TabsList className="border border-white/15 bg-white/10 text-white/70">
          <TabsTrigger
            value="article"
            className="text-white/75 hover:text-white data-[state=active]:bg-yellow-300 data-[state=active]:text-blue-950"
          >
            正文
          </TabsTrigger>
          <TabsTrigger
            value="mindmap"
            className="text-white/75 hover:text-white data-[state=active]:bg-yellow-300 data-[state=active]:text-blue-950"
          >
            思维导图
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}

function PublicArticleTabPanels({
  model,
  mindmapMounted,
}: {
  model: PublicArticlePageModel
  mindmapMounted: boolean
}) {
  return (
    <>
      <section hidden={model.tab !== "article"} aria-hidden={model.tab !== "article"}>
        <PublicArticlePanel
          contentJson={model.contentJson}
          contentMetaJson={model.contentMetaJson}
          contentMd={model.contentMd}
          toc={model.tocAll}
          activeHeadingId={model.activeHeadingId}
          onTocClick={model.onTocClick}
        />
      </section>

      {mindmapMounted ? (
        <section hidden={model.tab !== "mindmap"} aria-hidden={model.tab !== "mindmap"}>
          <PublicMindmapPanel data={model.mindmapData} loading={model.loading} />
        </section>
      ) : null}
    </>
  )
}

function BackToTopButton() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <button
      aria-label="返回顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-50 size-9 flex items-center justify-center",
        "rounded-full border border-white/20 bg-[#0044cc]/90 text-white backdrop-blur-sm shadow-md",
        "transition-[opacity,transform,background-color,color,box-shadow] duration-300 hover:bg-yellow-300 hover:text-blue-950 hover:shadow-lg",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-3 pointer-events-none"
      )}
    >
      <ChevronUp className="size-4" />
    </button>
  )
}
