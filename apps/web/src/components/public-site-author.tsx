import * as React from "react"
import { Link } from "react-router-dom"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { publicAboutProfileApi, type AboutProfileResponse } from "@/lib/api"

export function PublicSiteAuthor() {
  const [profile, setProfile] = React.useState<AboutProfileResponse | null>(() => publicAboutProfileApi.getCachedDetail())
  const [loading, setLoading] = React.useState(() => !publicAboutProfileApi.getCachedDetail())

  React.useEffect(() => {
    const cached = publicAboutProfileApi.getCachedDetail()
    if (cached) {
      setProfile(cached)
      setLoading(false)
      return
    }

    let canceled = false
    void publicAboutProfileApi.detail()
      .then((response) => {
        if (!canceled) setProfile(response.data)
      })
      .catch(() => {
        // 公开资料暂不可用时，保留进入作者介绍页的入口。
      })
      .finally(() => {
        if (!canceled) setLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="flex h-12 items-center gap-2" role="status" aria-label="加载作者信息">
        <span className="size-8 shrink-0 rounded-lg bg-[var(--retypeset-surface-tint)] motion-safe:animate-pulse" />
        <span className="grid gap-2" aria-hidden="true">
          <span className="h-3 w-16 rounded bg-[var(--retypeset-surface-tint)] motion-safe:animate-pulse" />
          <span className="h-2.5 w-28 rounded bg-[var(--retypeset-surface-tint)] motion-safe:animate-pulse" />
        </span>
      </div>
    )
  }

  const displayName = profile?.displayName.trim() || "作者"
  const signature = profile?.quote.trim() || profile?.roleTitle.trim() || "关于我"

  return (
    <Link
      to="/about"
      aria-label={`关于作者：${displayName}`}
      className="retypeset-font-navbar -ml-2 flex h-12 w-full min-w-0 items-center gap-2 rounded-xl px-2 text-left transition-colors hover:bg-[var(--retypeset-surface-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--retypeset-accent)] motion-reduce:transition-none"
    >
      <span className="relative shrink-0" aria-hidden="true">
        <Avatar className="size-8 rounded-lg">
          <AvatarFallback className="rounded-lg bg-[var(--retypeset-surface-tint)] text-[var(--retypeset-secondary)]">
            {Array.from(displayName).slice(0, 2).join("").toUpperCase()}
          </AvatarFallback>
          {/* 原生图片直接复用浏览器缓存，切页时无需重新等待 AvatarImage 的加载状态。 */}
          <img
            src="/about-avatar.avif"
            alt=""
            width={32}
            height={32}
            className="absolute inset-0 size-full object-cover"
            onError={(event) => { event.currentTarget.hidden = true }}
          />
        </Avatar>
        <span className="absolute bottom-0 right-0 size-2 rounded-full bg-emerald-500 ring-2 ring-[var(--retypeset-background)]" />
      </span>
      <span className="grid min-w-0 flex-1 text-sm leading-tight">
        <span className="retypeset-c-primary truncate font-medium" title={displayName}>{displayName}</span>
        <span className="retypeset-c-secondary truncate text-xs font-normal" title={signature}>{signature}</span>
      </span>
    </Link>
  )
}
