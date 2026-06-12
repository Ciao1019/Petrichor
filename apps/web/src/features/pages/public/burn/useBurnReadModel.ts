import * as React from "react"
import type { MindElixirData } from "mind-elixir"

import {
  publicBurnApi,
  type PublicBurnConsumeResponse,
  type PublicBurnState,
} from "@/lib/api"
import type { PublicArticlePageModel } from "@/features/pages/public/PublicArticlePageView"
import {
  buildFallbackMindmapData,
  extractFirstImageUrl,
  scrollToHeading,
} from "@/features/pages/public/public-article-utils"
import { usePublicArticleActiveHeading } from "@/features/pages/public/usePublicArticleActiveHeading"
import { usePublicArticleInitialHashScroll } from "@/features/pages/public/usePublicArticleInitialHashScroll"
import { usePublicArticleScrollOffset } from "@/features/pages/public/usePublicArticleScrollOffset"
import { usePublicArticleToc } from "@/features/pages/public/usePublicArticleToc"

const SCROLL_OFFSET_EXTRA_PX = 16

export type BurnReadPhase = "loading" | "confirm" | "consuming" | "article" | "gone"

function goneTextForState(state: PublicBurnState | null): string {
  switch (state) {
    case "BURNED":
      return "此链接为阅后即焚，已被销毁。"
    case "REVOKED":
      return "该链接已被作者撤销。"
    case "EXPIRED":
      return "该链接已过期。"
    default:
      return "链接不存在或已失效。"
  }
}

function resolveAxiosStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status
}

function resolveAxiosMessage(error: unknown, fallback: string): string {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg
    || (error instanceof Error ? error.message : "")
    || fallback
  )
}

export interface BurnReadModel {
  phase: BurnReadPhase
  requiresPassword: boolean
  accessPassword: string
  onAccessPasswordChange: (next: string) => void
  errorMessage: string | null
  goneText: string
  coverImageUrl: string | null
  burnNotice: PublicBurnConsumeResponse["burn"] | null
  onConfirmRead: () => void
  pageModel: PublicArticlePageModel
}

export function useBurnReadModel(code: string | undefined): BurnReadModel {
  const passwordId = React.useId()
  const [tab, setTab] = React.useState<PublicArticlePageModel["tab"]>("article")

  const [phase, setPhase] = React.useState<BurnReadPhase>("loading")
  const [requiresPassword, setRequiresPassword] = React.useState(false)
  const [accessPassword, setAccessPassword] = React.useState("")
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [goneText, setGoneText] = React.useState<string>(goneTextForState(null))
  const [data, setData] = React.useState<PublicBurnConsumeResponse | null>(null)
  const [burnNotice, setBurnNotice] = React.useState<PublicBurnConsumeResponse["burn"] | null>(null)
  const [coverImageUrl, setCoverImageUrl] = React.useState<string | null>(null)

  // 拉取链接元信息（仅状态/是否需要密码/封面图，不含正文）。
  React.useEffect(() => {
    setPhase("loading")
    setRequiresPassword(false)
    setAccessPassword("")
    setErrorMessage(null)
    setData(null)
    setBurnNotice(null)
    setCoverImageUrl(null)

    if (!code) {
      setGoneText(goneTextForState(null))
      setPhase("gone")
      return
    }

    let canceled = false
    publicBurnApi
      .meta(code)
      .then((res) => {
        if (canceled) return
        if (res.data.state === "ACTIVE") {
          setRequiresPassword(res.data.requiresPassword)
          setCoverImageUrl(res.data.coverImageUrl ?? null)
          setPhase("confirm")
        } else {
          setGoneText(goneTextForState(res.data.state))
          setPhase("gone")
        }
      })
      .catch((error: unknown) => {
        if (canceled) return
        setGoneText(resolveAxiosMessage(error, goneTextForState(null)))
        setPhase("gone")
      })

    return () => {
      canceled = true
    }
  }, [code])

  const onConfirmRead = React.useCallback(() => {
    if (!code) return
    if (requiresPassword && accessPassword.length < 6) {
      setErrorMessage("请输入 6 位访问密码")
      return
    }
    setPhase("consuming")
    setErrorMessage(null)
    publicBurnApi
      .consume(code, requiresPassword ? accessPassword : null)
      .then((res) => {
        setData(res.data)
        setBurnNotice(res.data.burn)
        setPhase("article")
      })
      .catch((error: unknown) => {
        const status = resolveAxiosStatus(error)
        const message = resolveAxiosMessage(error, "打开失败")
        if (status === 403) {
          // 密码错误：留在确认页重试，不消耗次数。
          setRequiresPassword(true)
          setErrorMessage(message)
          setPhase("confirm")
          return
        }
        if (status === 410 || status === 404) {
          setGoneText(message)
          setPhase("gone")
          return
        }
        setErrorMessage(message)
        setPhase("confirm")
      })
  }, [accessPassword, code, requiresPassword])

  // 以下 toc / 滚动 / 标题高亮均复用公开文章页逻辑；data 为空时安全降级。
  const { tocAll, navToc, headingIds } = usePublicArticleToc(data?.contentMd, data?.tocJson)
  const { articleRef, scrollOffsetPx } = usePublicArticleScrollOffset(SCROLL_OFFSET_EXTRA_PX)
  const { activeHeadingId, setActiveHeadingId } = usePublicArticleActiveHeading({ tab, navToc, scrollOffsetPx })
  const handleScrollTo = React.useCallback((id: string) => {
    scrollToHeading(id)
    setActiveHeadingId(id)
  }, [setActiveHeadingId])
  usePublicArticleInitialHashScroll({
    shareCode: code,
    tab,
    contentMd: data?.contentMd,
    headingIds,
    onScrollTo: handleScrollTo,
  })

  const mindmapData = React.useMemo<MindElixirData | null>(() => {
    const fromApi = (data?.mindmapData ?? null) as MindElixirData | null
    if (fromApi) return fromApi
    if (!data) return null
    return buildFallbackMindmapData(data.title || "文章", tocAll)
  }, [data, tocAll])

  const repostSource = data?.isRepost && data.originalUrl && data.originalAuthorName
    ? { originalUrl: data.originalUrl, originalAuthorName: data.originalAuthorName }
    : null

  const pageModel: PublicArticlePageModel = {
    shareCode: code,
    shareUrl: "",
    hasArticleData: Boolean(data),
    loading: phase === "consuming",
    error: null,
    needPassword: false,
    passwordId,
    accessPassword: "",
    onAccessPasswordChange: () => {},
    onSubmitPassword: () => {},
    articleRef,
    title: data?.title || "未命名文章",
    tags: Array.isArray(data?.tags) ? data?.tags : null,
    createdAt: data?.createdAt ?? null,
    updatedAt: data?.updatedAt ?? null,
    aiSummary: data?.aiSummary?.trim() || null,
    coverImageUrl: extractFirstImageUrl(data?.contentMd ?? "") ?? null,
    repostSource,
    tab,
    onTabChange: setTab,
    contentMd: data?.contentMd || "",
    contentJson: data?.contentJson ?? null,
    contentMetaJson: data?.contentMetaJson ?? null,
    tocAll,
    activeHeadingId,
    onTocClick: handleScrollTo,
    mindmapData,
  }

  return {
    phase,
    requiresPassword,
    accessPassword,
    onAccessPasswordChange: setAccessPassword,
    errorMessage,
    goneText,
    coverImageUrl,
    burnNotice,
    onConfirmRead,
    pageModel,
  }
}
