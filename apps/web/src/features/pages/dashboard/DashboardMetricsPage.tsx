"use client"

import * as React from "react"
import { toast } from "sonner"

import { dashboardApi, type DashboardOverviewResponse } from "@/lib/api"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { ActivityTrendChart } from "./components/ActivityTrendChart"
import { ContributionHeatmap } from "./components/ContributionHeatmap"
import { DistributionChart } from "./components/DistributionChart"
import { KpiCards } from "./components/KpiCards"
import { RecentThreadsList } from "./components/RecentThreadsList"

export function DashboardMetricsPage() {
  const [overview, setOverview] = React.useState<DashboardOverviewResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    dashboardApi
      .overview()
      .then((res) => {
        if (active) setOverview(res.data)
      })
      .catch((error) => {
        if (active) toast.error(resolveAxiosErrorMessage(error, "加载仪表盘数据失败"))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">概览</h1>
        <p className="text-muted-foreground text-sm">你的知识库与问答活动一览</p>
      </div>

      <KpiCards kpis={overview?.kpis} loading={loading} />

      <ContributionHeatmap
        points={overview?.heatmap.points ?? []}
        total={overview?.heatmap.total ?? 0}
        start={overview?.heatmap.start ?? ""}
        end={overview?.heatmap.end ?? ""}
        loading={loading}
      />

      <div className="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
        <ActivityTrendChart data={overview?.trend ?? []} loading={loading} />
        <DistributionChart
          knowledgeBases={overview?.distribution.knowledgeBases ?? []}
          tags={overview?.distribution.tags ?? []}
          loading={loading}
        />
      </div>

      <RecentThreadsList threads={overview?.recentThreads ?? []} loading={loading} />
    </div>
  )
}
