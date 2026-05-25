import * as React from "react"

import type { PublicArticleTocItem } from "@/lib/api"
import { buildToc } from "@/features/pages/public/public-article-utils"

const NAV_TOC_MIN_LEVEL = 2
const NAV_TOC_MAX_LEVEL = 4

export function usePublicArticleToc(
  contentMd: string | null | undefined,
  serverToc: PublicArticleTocItem[] | null | undefined
) {
  const tocAll = React.useMemo(() => {
    if (Array.isArray(serverToc)) {
      return serverToc
    }
    return buildToc(contentMd || "")
  }, [contentMd, serverToc])
  const navToc = React.useMemo(
    () => tocAll.filter((item) => item.level >= NAV_TOC_MIN_LEVEL && item.level <= NAV_TOC_MAX_LEVEL),
    [tocAll]
  )
  const headingIds = React.useMemo(() => tocAll.map((item) => item.id), [tocAll])

  return { tocAll, navToc, headingIds }
}
