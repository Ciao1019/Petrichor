"use client"

import { ArrowRight, MessageCircle } from "@/components/iconimate"
import { useNavigate } from "react-router-dom"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import type { AssistantThreadSummary } from "@/lib/api"

type RecentThreadsListProps = {
  threads: AssistantThreadSummary[]
  loading?: boolean
}

function relativeTime(value?: string | null) {
  if (!value) return ""
  const target = new Date(value).getTime()
  if (Number.isNaN(target)) return ""
  const diffMs = Date.now() - target
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
}

export function RecentThreadsList({ threads, loading }: RecentThreadsListProps) {
  const navigate = useNavigate()

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>最近对话</CardTitle>
        <CardDescription>你最近在助手里发起的对话</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => navigate(dashboardRoutes.assistant)}
          >
            全部
            <ArrowRight className="size-3.5" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="bg-muted/50 h-12 w-full animate-pulse rounded-md" />
          ))
        ) : threads.length === 0 ? (
          <div className="text-muted-foreground flex h-[180px] flex-col items-center justify-center gap-2 text-sm">
            <MessageCircle className="size-6 opacity-40" />
            还没有对话记录
          </div>
        ) : (
          threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => navigate(dashboardRoutes.assistant)}
              className="hover:bg-accent/60 group flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors"
            >
              <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
                <MessageCircle className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {thread.title || "未命名对话"}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {relativeTime(thread.updatedAt ?? thread.createdAt)}
                </span>
              </span>
              <ArrowRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))
        )}
      </CardContent>
    </Card>
  )
}
