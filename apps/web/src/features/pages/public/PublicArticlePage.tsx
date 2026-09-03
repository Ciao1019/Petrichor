import { useParams } from "react-router-dom"

import { usePublicPageMeta } from "@/features/pages/public-page-meta"
import { PublicArticlePageView } from "@/features/pages/public/PublicArticlePageView"
import { usePublicArticlePageModel } from "@/features/pages/public/usePublicArticlePageModel"

export function PublicArticlePage() {
  const { shareCode } = useParams()
  const model = usePublicArticlePageModel(shareCode)
  usePublicPageMeta(
    `${model.title} · Petrichor`,
    model.aiSummary || "阅读公开文章与相关知识内容。",
    `/p/${encodeURIComponent(shareCode || "")}`,
  )
  return <PublicArticlePageView model={model} />
}
