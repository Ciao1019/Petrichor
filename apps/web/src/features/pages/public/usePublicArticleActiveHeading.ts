import * as React from "react"

import type { TocItem } from "@/features/pages/public/public-article-utils"

type UsePublicArticleActiveHeadingOptions = {
  tab: "article" | "mindmap"
  navToc: TocItem[]
  scrollOffsetPx: number
}

export function usePublicArticleActiveHeading({ tab, navToc, scrollOffsetPx }: UsePublicArticleActiveHeadingOptions) {
  const [activeHeadingId, setActiveHeadingId] = React.useState("")

  React.useEffect(() => {
    if (navToc.length === 0) {
      setActiveHeadingId("")
      return
    }
    setActiveHeadingId((prev) => {
      if (!prev) return navToc[0].id
      return navToc.some((item) => item.id === prev) ? prev : navToc[0].id
    })
  }, [navToc])

  React.useEffect(() => {
    if (tab !== "article" || navToc.length === 0 || typeof window === "undefined") return
    const ids = navToc.map((item) => item.id)
    let ticking = false

    const updateActiveHeading = () => {
      const currentScrollTop = window.scrollY + scrollOffsetPx + 1
      let nextId = ids[0]
      for (const id of ids) {
        const heading = document.getElementById(id)
        if (!heading) continue
        const top = heading.getBoundingClientRect().top + window.scrollY
        if (top <= currentScrollTop) nextId = id
      }
      setActiveHeadingId(nextId)
    }

    updateActiveHeading()
    const requestUpdate = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => {
        ticking = false
        updateActiveHeading()
      })
    }

    window.addEventListener("scroll", requestUpdate, { passive: true })
    window.addEventListener("resize", requestUpdate)
    return () => {
      window.removeEventListener("scroll", requestUpdate)
      window.removeEventListener("resize", requestUpdate)
    }
  }, [tab, navToc, scrollOffsetPx])

  return { activeHeadingId, setActiveHeadingId }
}
