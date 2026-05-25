import * as React from "react"

const DEFAULT_SCROLL_OFFSET_PX = 24

export function usePublicArticleScrollOffset(extraPx: number) {
  const [articleEl, setArticleEl] = React.useState<HTMLElement | null>(null)
  const scrollOffsetPx = DEFAULT_SCROLL_OFFSET_PX + extraPx

  const articleRef = React.useCallback((node: HTMLElement | null) => {
    setArticleEl(node)
  }, [])

  React.useEffect(() => {
    if (!articleEl) return
    articleEl.style.setProperty("--public-article-scroll-offset", `${scrollOffsetPx}px`)
  }, [articleEl, scrollOffsetPx])

  return { articleRef, scrollOffsetPx }
}
