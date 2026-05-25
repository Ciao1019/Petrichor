import * as React from "react"

type UsePublicArticleInitialHashScrollOptions = {
  shareCode: string | undefined
  tab: "article" | "mindmap"
  contentMd: string | null | undefined
  headingIds: string[]
  onScrollTo: (id: string) => void
}

export function usePublicArticleInitialHashScroll({
  shareCode,
  tab,
  contentMd,
  headingIds,
  onScrollTo,
}: UsePublicArticleInitialHashScrollOptions) {
  const didInitialHashScrollRef = React.useRef(false)

  React.useEffect(() => {
    didInitialHashScrollRef.current = false
  }, [shareCode])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (didInitialHashScrollRef.current) return
    if (tab !== "article") return
    if (!contentMd) return

    const rawHash = window.location.hash
    if (!rawHash || rawHash.length <= 1) return

    let id = ""
    try {
      id = decodeURIComponent(rawHash.slice(1))
    } catch {
      return
    }
    if (!id || !headingIds.includes(id)) return

    didInitialHashScrollRef.current = true
    window.requestAnimationFrame(() => onScrollTo(id))
  }, [tab, contentMd, headingIds, onScrollTo])
}
