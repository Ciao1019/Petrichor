import { useState, useEffect, useRef, type Ref } from "react"
import { motion, AnimatePresence } from "motion/react"
import { QRCodeSVG } from "qrcode.react"
import type { MindElixirData } from "mind-elixir"
import { ChevronUp, GalleryHorizontalEnd, ImageIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PixelFlowerLayer, type PixelFlowerDecoration } from "@/features/pages/blog/PixelDecorations"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { PublicArticleErrorCard, PublicArticlePasswordCard } from "@/features/pages/public/PublicArticleChrome"
import { PublicArticlePanel, PublicMindmapPanel } from "@/features/pages/public/PublicArticlePanels"
import {
  shouldRenderPublicArticleBody,
  shouldShowPublicArticleLoadingCard,
} from "@/features/pages/public/public-article-render-state"
import { useSignedUrl } from "@/hooks/use-signed-url"
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
  const [cardDialogOpen, setCardDialogOpen] = useState(false)

  const handleTabChange = (nextTab: PublicArticlePageModel["tab"]) => {
    if (nextTab === "mindmap") setMindmapMounted(true)
    onTabChange(nextTab)
  }

  return (
    <article ref={articleRef} className="public-article public-article--retypeset">
      <PublicArticleRepostAttribution source={model.repostSource} />
      <PublicArticleTitleSection title={title} createdAt={createdAt} updatedAt={updatedAt} />
      <PublicArticleActions onGenerateCard={() => setCardDialogOpen(true)} />
      <PublicArticleAiSummary summary={model.aiSummary} />
      <PublicArticleTabs tab={tab} onTabChange={handleTabChange} />
      <PublicArticleTabPanels
        model={model}
        mindmapMounted={mindmapMounted || tab === "mindmap"}
      />
      <PublicArticleTagsFooter tags={tags} />
      <ArticleCardDialog
        open={cardDialogOpen}
        onOpenChange={setCardDialogOpen}
        title={title}
        createdAt={createdAt ?? null}
        aiSummary={model.aiSummary}
        coverImageUrl={model.coverImageUrl}
        shareUrl={model.shareUrl}
        tags={model.tags ?? []}
      />
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

function PublicArticleActions({ onGenerateCard }: { onGenerateCard: () => void }) {
  return (
    <div className="mb-5 flex items-center gap-2">
      <button
        type="button"
        onClick={onGenerateCard}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-white/20 bg-white/10 px-3 py-1.5",
          "text-xs text-white/70 transition-colors hover:border-yellow-300/50 hover:bg-yellow-300/15 hover:text-yellow-300",
        )}
      >
        <GalleryHorizontalEnd className="size-3.5" />
        生成文章卡片
      </button>
    </div>
  )
}

function ArticleCardDialog({
  open,
  onOpenChange,
  title,
  createdAt,
  aiSummary,
  coverImageUrl,
  shareUrl,
  tags,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  createdAt: string | null
  aiSummary: string | null
  coverImageUrl: string | null
  shareUrl: string
  tags: string[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="border-0 bg-transparent p-0 shadow-none sm:max-w-[480px]"
      >
        <DialogTitle className="sr-only">文章卡片</DialogTitle>
        <ArticleCardPreview
          title={title}
          createdAt={createdAt}
          aiSummary={aiSummary}
          coverImageUrl={coverImageUrl}
          shareUrl={shareUrl}
          tags={tags}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

const TAG_COLORS = [
  { bg: "#EAF0FF", fg: "#2d5be3", border: "#c5d5fa" },
  { bg: "#FFF8E6", fg: "#a0620a", border: "#f5dfa0" },
  { bg: "#EDFAF3", fg: "#1a7a4a", border: "#a8e6c5" },
  { bg: "#FFF0F3", fg: "#c0314a", border: "#f5b8c4" },
  { bg: "#F3EEFF", fg: "#6e38cc", border: "#d4bbf7" },
] as const

const CARD = {
  paper:       "#F3F2EE",
  paperShade:  "#E8E7E2",
  ink:         "#161615",
  inkLight:    "#5A5A58",
  borderLight: "rgba(22,22,21,0.10)",
  borderDark:  "rgba(22,22,21,0.28)",
  fontDisplay: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  fontSans:    "'Manrope', system-ui, sans-serif",
  fontMono:    "'JetBrains Mono', 'Courier New', monospace",
} as const

function ArticleCardPreview({
  title,
  createdAt,
  aiSummary,
  coverImageUrl,
  shareUrl,
  tags,
  onClose,
}: {
  title: string
  createdAt: string | null
  aiSummary: string | null
  coverImageUrl: string | null
  shareUrl: string
  tags: string[]
  onClose?: () => void
}) {
  const signedCoverImageUrl = useSignedUrl(coverImageUrl, true)
  const resolvedCoverImageUrl = signedCoverImageUrl ?? coverImageUrl
  const cardRef = useRef<HTMLDivElement>(null)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!cardRef.current || copying) return
    setCopying(true)
    try {
      const { toPng } = await import("html-to-image")
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 2 })
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    } finally {
      setCopying(false)
    }
  }

  return (
    <div
      aria-label="文章卡片预览"
      style={{
        width: 420,
        background: CARD.paper,
        borderRadius: 6,
        overflow: "hidden",
        boxShadow: "0 24px 48px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)",
        fontFamily: CARD.fontSans,
      }}
    >
      {/* 仅这个 div 会被截图，不含底部操作栏 */}
      <div ref={cardRef}>
      {/* ── 上方横图区域 ── */}
      <div style={{ position: "relative", background: CARD.paperShade, borderBottom: `1px solid ${CARD.borderLight}`, overflow: "hidden" }}>
        {resolvedCoverImageUrl ? (
          <img
            src={resolvedCoverImageUrl}
            alt=""
            style={{ display: "block", width: "100%", height: "auto", filter: "contrast(1.04) saturate(0.88)" }}
          />
        ) : (
          // 无图：固定高度 + 点阵 + 占位图标
          <div style={{ height: 160, position: "relative" }}>
            <div style={{
              position: "absolute", inset: 0,
              backgroundImage: `radial-gradient(circle, rgba(22,22,21,0.09) 1px, transparent 1px)`,
              backgroundSize: "14px 14px",
            }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{
                width: 40, height: 40, borderRadius: "50%",
                border: `1px solid ${CARD.borderDark}`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <ImageIcon style={{ width: 16, height: 16, color: CARD.inkLight }} />
              </div>
            </div>
            <div style={{ position: "absolute", inset: 10, border: `1px dashed ${CARD.borderLight}`, borderRadius: 3 }} />
          </div>
        )}
      </div>

      {/* ── 下方内容区 ── */}
      <div style={{ padding: "16px 20px 18px" }}>
        {/* 分割线 */}
        <div style={{ height: 1, background: CARD.borderDark, marginBottom: 12 }} />

        {/* 标题 */}
        <h2 style={{
          fontFamily: CARD.fontDisplay,
          fontSize: 26,
          fontWeight: 400,
          lineHeight: 1.05,
          letterSpacing: "-0.01em",
          color: CARD.ink,
          marginBottom: 12,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {title || "文章标题"}
        </h2>

        {/* AI 总结 + 二维码 */}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
          <p style={{
            flex: 1,
            fontFamily: CARD.fontSans,
            fontSize: 10,
            lineHeight: 1.75,
            color: CARD.inkLight,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {aiSummary?.trim() || "暂无 AI 总结"}
          </p>
          <ArticleCardQr url={shareUrl} />
        </div>

        {/* ── 标签行 ── */}
        {tags.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {tags.slice(0, 5).map((tag, i) => (
              <span
                key={tag}
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  fontSize: 9,
                  fontFamily: CARD.fontSans,
                  letterSpacing: "0.03em",
                  background: TAG_COLORS[i % TAG_COLORS.length].bg,
                  color: TAG_COLORS[i % TAG_COLORS.length].fg,
                  border: `1px solid ${TAG_COLORS[i % TAG_COLORS.length].border}`,
                }}
              >
                # {tag}
              </span>
            ))}
          </div>
        ) : null}

      </div>{/* closes padding div */}
      </div>{/* closes cardRef — 截图范围到此结束 */}

      {/* ── 底部操作栏（截图范围外）── */}
      <div style={{
        padding: "12px 20px 16px",
        borderTop: `1px solid ${CARD.borderLight}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <span style={{ fontFamily: CARD.fontMono, fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", color: CARD.inkLight }}>
          生成可分享的文章卡片图片
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CopyImageButton copying={copying} copied={copied} onClick={handleCopy} />
          {onClose ? (
            <motion.button
              type="button"
              onClick={onClose}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28,
                background: "linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,255,255,0.62))",
                border: "1px solid rgba(0,0,0,0.06)",
                boxShadow: "0 0 1px rgba(0,0,0,0.04),0 2px 8px rgba(0,0,0,0.04),inset 0 1px 0 rgba(255,255,255,0.8)",
                backdropFilter: "blur(24px)",
                borderRadius: 8,
                cursor: "pointer",
                color: "rgba(0,0,0,0.5)",
                fontSize: 12,
                outline: "none",
              }}
            >
              ✕
            </motion.button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const COPY_BTN_CSS = `
.cib{
  --bc-glass:linear-gradient(180deg,rgba(255,255,255,0.78),rgba(255,255,255,0.62));
  --bc-border:rgba(0,0,0,0.06);
  --bc-shadow:0 0 1px rgba(0,0,0,0.04),0 2px 8px rgba(0,0,0,0.04),inset 0 1px 0 rgba(255,255,255,0.8);
  --bc-hi:rgba(0,0,0,0.88);
  --bc-ok:#34C759
}`

function CopyImageButton({ copying, copied, onClick }: { copying: boolean; copied: boolean; onClick: () => void }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: COPY_BTN_CSS }} />
      <motion.button
        type="button"
        className="cib"
        onClick={onClick}
        disabled={copying}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 10,
          border: "1px solid var(--bc-border)",
          background: "var(--bc-glass)",
          boxShadow: "var(--bc-shadow)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          color: copied ? "var(--bc-ok)" : "var(--bc-hi)",
          fontSize: 12,
          fontWeight: 500,
          cursor: copying ? "wait" : "pointer",
          outline: "none",
          userSelect: "none",
          transition: "color 0.2s",
          opacity: copying ? 0.7 : 1,
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.svg key="chk" width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}
              transition={{ type: "spring", stiffness: 500, damping: 25 }}
            >
              <motion.path d="M5 13l4 4L19 7" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }} />
            </motion.svg>
          ) : (
            <motion.svg key="cpy" width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }}
              transition={{ type: "spring", stiffness: 500, damping: 25 }}
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </motion.svg>
          )}
        </AnimatePresence>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? "d" : copying ? "w" : "i"}
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
          >
            {copied ? "已复制" : copying ? "处理中..." : "复制图片"}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </>
  )
}

function ArticleCardQr({ url }: { url: string }) {
  return (
    <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <div style={{
        padding: 4,
        background: "#fff",
        border: `1px solid ${CARD.borderDark}`,
        borderRadius: 3,
        lineHeight: 0,
      }}>
        <QRCodeSVG
          value={url || window.location.href}
          size={54}
          fgColor={CARD.ink}
          bgColor="#ffffff"
          level="M"
          marginSize={0}
        />
      </div>
      <span style={{ fontFamily: CARD.fontMono, fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", color: CARD.inkLight }}>
        扫码查看原文
      </span>
    </div>
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
