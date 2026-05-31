"use client"

import { Activity, FileText, Library, MessagesSquare } from "lucide-react"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DashboardOverviewResponse } from "@/lib/api"

type KpiCardsProps = {
  kpis?: DashboardOverviewResponse["kpis"]
  loading?: boolean
}

type KpiItem = {
  key: keyof DashboardOverviewResponse["kpis"]
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const ITEMS: KpiItem[] = [
  { key: "articles", label: "文章总数", icon: FileText },
  { key: "qaThreads", label: "问答记录", icon: MessagesSquare },
  { key: "knowledgeBases", label: "知识库", icon: Library },
  { key: "activity7d", label: "近 7 天活跃", icon: Activity },
]

export function KpiCards({ kpis, loading }: KpiCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {ITEMS.map((item) => {
        const Icon = item.icon
        const value = kpis?.[item.key] ?? 0
        return (
          <Card
            key={item.key}
            className="@container/card from-primary/5 to-card gap-2 bg-gradient-to-t shadow-xs"
          >
            <CardHeader className="gap-1">
              <div className="flex items-center justify-between">
                <CardDescription>{item.label}</CardDescription>
                <Icon className="text-muted-foreground size-4" />
              </div>
              <CardTitle className="text-2xl font-semibold tabular-nums @[180px]/card:text-3xl">
                {loading ? (
                  <span className="bg-muted inline-block h-7 w-12 animate-pulse rounded" />
                ) : (
                  value.toLocaleString("zh-CN")
                )}
              </CardTitle>
            </CardHeader>
          </Card>
        )
      })}
    </div>
  )
}
