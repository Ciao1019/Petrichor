import { useParams } from "react-router-dom"

import { PublicArticlePageView } from "@/features/pages/public/PublicArticlePageView"
import { usePublicArticlePageModel } from "@/features/pages/public/usePublicArticlePageModel"

export function PublicArticlePage() {
  const { shareCode } = useParams()
  const model = usePublicArticlePageModel(shareCode)
  return <PublicArticlePageView model={model} />
}
