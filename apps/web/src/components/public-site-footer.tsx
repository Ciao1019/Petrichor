"use client"

import * as React from "react"

import FooterPro, { type FooterProLink } from "@/components/ruixenui/footer-pro"
import { publicSiteFilingApi, type SiteFilingResponse } from "@/lib/api"

function safeHTTPURL(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function buildFilingLinks(config: SiteFilingResponse | null): FooterProLink[] {
  if (!config?.enabled) return []

  const links: FooterProLink[] = []
  if (config.icpNumber.trim() && safeHTTPURL(config.icpUrl)) {
    links.push({ label: config.icpNumber.trim(), href: config.icpUrl })
  }
  if (config.publicSecurityNumber.trim() && safeHTTPURL(config.publicSecurityUrl)) {
    links.push({ label: config.publicSecurityNumber.trim(), href: config.publicSecurityUrl })
  }
  return links
}

export function PublicSiteFooter({ className }: { className?: string }) {
  const [filing, setFiling] = React.useState<SiteFilingResponse | null>(() => publicSiteFilingApi.getCachedDetail())

  React.useEffect(() => {
    const cached = publicSiteFilingApi.getCachedDetail()
    if (cached) {
      setFiling(cached)
      return
    }

    let canceled = false
    void publicSiteFilingApi.detail()
      .then((response) => {
        if (!canceled) setFiling(response.data)
      })
      .catch(() => {
        // 备案配置不可用时不影响公开页面，只是不展示备案信息。
      })
    return () => {
      canceled = true
    }
  }, [])

  return <FooterPro bottomLinks={buildFilingLinks(filing)} className={className} />
}
