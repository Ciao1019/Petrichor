"use client"

import { FileText, History, MessageCircle } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import type { DashboardActivityItem } from "@/lib/api"
import { VIZ, relativeTime } from "../metrics-utils"

type RecentActivityFeedProps = {
  items: DashboardActivityItem[]
  loading?: boolean
}

const KIND_META = {
  article: { icon: FileText, label: "文章", color: VIZ.slot1 },
  thread: { icon: MessageCircle, label: "对话", color: VIZ.slot2 },
} as const

export function RecentActivityFeed({ items, loading }: RecentActivityFeedProps) {
  const navigate = useNavigate()

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>最近动态</CardTitle>
        <CardDescription>文章发布与助手对话的时间线</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground flex h-[196px] flex-col items-center justify-center gap-2 text-sm">
            <History className="size-6 opacity-40" />
            还没有动态记录
          </div>
        ) : (
          <ol className="flex flex-col">
            {items.map((item, index) => {
              const meta = KIND_META[item.kind]
              const Icon = meta.icon
              const last = index === items.length - 1
              return (
                <li key={`${item.kind}-${item.id}`} className="flex gap-3">
                  {/* 时间线竖线 */}
                  <div className="flex flex-col items-center">
                    <span
                      className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full"
                      style={{ background: `color-mix(in oklab, ${meta.color} 16%, transparent)` }}
                    >
                      <Icon className="size-3" style={{ color: meta.color }} />
                    </span>
                    {!last ? <span className="bg-border w-px flex-1" /> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        item.kind === "thread"
                          ? dashboardRoutes.assistant
                          : dashboardRoutes.knowledge,
                      )
                    }
                    className="hover:bg-accent/60 -mx-2 mb-1 min-w-0 flex-1 rounded-md px-2 py-1 text-left transition-colors"
                  >
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <span>{meta.label}</span>
                      {item.subtitle ? (
                        <>
                          <span className="opacity-40">·</span>
                          <span className="truncate">{item.subtitle}</span>
                        </>
                      ) : null}
                      <span className="opacity-40">·</span>
                      <span className="tabular-nums">{relativeTime(item.at)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
