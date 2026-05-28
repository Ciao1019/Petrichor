"use client"

import { ArrowRight, MessageCircle } from "lucide-react"
import { useNavigate } from "react-router-dom"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import type { KnowledgeBaseAgentThreadResponse } from "@/lib/api"

type RecentThreadsListProps = {
  threads: KnowledgeBaseAgentThreadResponse[]
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
        <CardTitle>最近问答</CardTitle>
        <CardDescription>你最近发起的知识库问答</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => navigate(dashboardRoutes.qa)}
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
            还没有问答记录
          </div>
        ) : (
          threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => navigate(dashboardRoutes.qa)}
              className="hover:bg-accent/60 group flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors"
            >
              <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
                <MessageCircle className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {thread.title || "未命名对话"}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  {thread.knowledgeBaseName ? (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                      {thread.knowledgeBaseName}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                      跨库
                    </Badge>
                  )}
                  <span className="tabular-nums">{relativeTime(thread.updatedAt ?? thread.createdAt)}</span>
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
