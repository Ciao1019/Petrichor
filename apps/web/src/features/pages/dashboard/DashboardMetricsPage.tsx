"use client"

import * as React from "react"
import { toast } from "sonner"

import { dashboardApi, type DashboardOverviewResponse } from "@/lib/api"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { cn } from "@/lib/utils"
import { RANGE_OPTIONS, type RangeValue, sliceTrend } from "./metrics-utils"
import { ActivityTrendChart } from "./components/ActivityTrendChart"
import { AgentHealthPanel } from "./components/AgentHealthPanel"
import { AssetComposition } from "./components/AssetComposition"
import { ContributionHeatmap } from "./components/ContributionHeatmap"
import { DistributionChart } from "./components/DistributionChart"
import { GrowthChart } from "./components/GrowthChart"
import { KpiCards } from "./components/KpiCards"
import { MetricsHeader } from "./components/MetricsHeader"
import { PipelineStatusPanel } from "./components/PipelineStatusPanel"
import { RecentActivityFeed } from "./components/RecentActivityFeed"
import { RecentThreadsList } from "./components/RecentThreadsList"
import { ToolUsageChart } from "./components/ToolUsageChart"
import { WritingRhythmGrid } from "./components/WritingRhythmGrid"

export function DashboardMetricsPage() {
  const [overview, setOverview] = React.useState<DashboardOverviewResponse | null>(null)
  // 首屏才出骨架屏；手动刷新时保留上一版渲染，只降低透明度，避免整页跳动
  const [refreshing, setRefreshing] = React.useState(false)
  const [range, setRange] = React.useState<RangeValue>(30)

  const load = React.useCallback(() => {
    let active = true
    setRefreshing(true)
    dashboardApi
      .overview()
      .then((res) => {
        if (active) setOverview(res.data)
      })
      .catch((error) => {
        if (active) toast.error(resolveAxiosErrorMessage(error, "加载仪表盘数据失败"))
      })
      .finally(() => {
        if (active) setRefreshing(false)
      })
    return () => {
      active = false
    }
  }, [])

  React.useEffect(() => load(), [load])

  const firstLoad = overview === null
  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === range)?.label ?? `${range} 天`
  const trend = React.useMemo(
    () => sliceTrend(overview?.trend ?? [], range),
    [overview?.trend, range],
  )

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 p-4 md:gap-5 md:p-6">
      <MetricsHeader
        range={range}
        onRangeChange={setRange}
        onRefresh={load}
        generatedAt={overview?.generatedAt}
        loading={refreshing}
      />

      <div
        className={cn(
          "flex flex-col gap-4 transition-opacity md:gap-5",
          refreshing && !firstLoad && "opacity-60",
        )}
      >
        <KpiCards
          primary={overview?.kpis.primary}
          secondary={overview?.kpis.secondary}
          loading={firstLoad}
        />

        <div className="grid grid-cols-1 gap-4 md:gap-5 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <ActivityTrendChart data={trend} rangeLabel={rangeLabel} loading={firstLoad} />
          </div>
          <AssetComposition items={overview?.assets ?? []} loading={firstLoad} />
        </div>

        <ContributionHeatmap
          points={overview?.heatmap.points ?? []}
          total={overview?.heatmap.total ?? 0}
          start={overview?.heatmap.start ?? ""}
          end={overview?.heatmap.end ?? ""}
          loading={firstLoad}
        />

        <div className="grid grid-cols-1 gap-4 md:gap-5 xl:grid-cols-2">
          <GrowthChart data={overview?.growth ?? []} loading={firstLoad} />
          <WritingRhythmGrid cells={overview?.rhythm.cells ?? []} loading={firstLoad} />
        </div>

        <AgentHealthPanel agent={overview?.agent} loading={firstLoad} />

        <div className="grid grid-cols-1 gap-4 md:gap-5 xl:grid-cols-2">
          <DistributionChart
            knowledgeBases={overview?.distribution.knowledgeBases ?? []}
            tags={overview?.distribution.tags ?? []}
            loading={firstLoad}
          />
          <ToolUsageChart
            items={overview?.tools.items ?? []}
            windowDays={overview?.tools.windowDays ?? 30}
            loading={firstLoad}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:gap-5 xl:grid-cols-3">
          <PipelineStatusPanel pipeline={overview?.pipeline} loading={firstLoad} />
          <RecentActivityFeed items={overview?.recentActivity ?? []} loading={firstLoad} />
          <RecentThreadsList threads={overview?.recentThreads ?? []} loading={firstLoad} />
        </div>
      </div>
    </div>
  )
}
