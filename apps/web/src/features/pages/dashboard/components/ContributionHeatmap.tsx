"use client"

import * as React from "react"
import * as HeatGraph from "heat-graph"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DashboardHeatmapPoint } from "@/lib/api"

// 与站点主题联动的色阶：0 级为留白，越深表示当天活动越多。
// 使用 color-mix + --primary，自动适配明暗主题。
const COLOR_SCALE = [
  "var(--muted)",
  "color-mix(in oklab, var(--primary) 28%, var(--muted))",
  "color-mix(in oklab, var(--primary) 50%, transparent)",
  "color-mix(in oklab, var(--primary) 72%, transparent)",
  "var(--primary)",
]

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"]
// 仅显示一/三/五，贴近 GitHub 的稀疏标注
const VISIBLE_WEEKDAYS = new Set([1, 3, 5])

type ContributionHeatmapProps = {
  points: DashboardHeatmapPoint[]
  total: number
  start?: string
  end?: string
  loading?: boolean
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function ContributionHeatmap({ points, total, start, end, loading }: ContributionHeatmapProps) {
  const data = React.useMemo(
    () => points.map((point) => ({ date: point.date, count: point.count })),
    [points],
  )

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>文章热力图</CardTitle>
        <CardDescription>
          过去一年共发布 <span className="text-foreground font-medium tabular-nums">{total}</span> 篇文章
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="bg-muted/50 h-[160px] w-full animate-pulse rounded-md" />
        ) : (
          <div className="overflow-x-auto pb-1">
            <HeatGraph.Root
              data={data}
              start={start || undefined}
              end={end || undefined}
              weekStart="monday"
              colorScale={COLOR_SCALE}
              className="min-w-[720px]"
            >
              <div className="flex gap-2">
                {/* 左侧：月份行占位 + 星期标签 */}
                <div className="flex shrink-0 flex-col gap-1 pt-[18px]">
                  <div className="grid grid-rows-7 gap-[3px]">
                    <HeatGraph.DayLabels>
                      {({ label }) => (
                        <div
                          key={label.row}
                          className="text-muted-foreground flex h-[12px] items-center text-[10px] leading-none"
                          style={{ gridRow: label.row + 1 }}
                        >
                          {VISIBLE_WEEKDAYS.has(label.dayOfWeek)
                            ? WEEKDAY_LABELS[label.dayOfWeek]
                            : ""}
                        </div>
                      )}
                    </HeatGraph.DayLabels>
                  </div>
                </div>

                {/* 右侧：月份标签 + 格子网格 */}
                <div className="min-w-0 flex-1">
                  <div className="relative mb-1 h-[14px]">
                    <HeatGraph.MonthLabels>
                      {({ label, totalWeeks }) => (
                        <span
                          key={`${label.month}-${label.column}`}
                          className="text-muted-foreground absolute text-[10px] leading-none"
                          style={{ left: `${(label.column / totalWeeks) * 100}%` }}
                        >
                          {label.month + 1}月
                        </span>
                      )}
                    </HeatGraph.MonthLabels>
                  </div>
                  <HeatGraph.Grid className="gap-[3px]">
                    {() => (
                      <HeatGraph.Cell className="hover:ring-ring/60 aspect-square rounded-[3px] transition-[outline] hover:ring-1" />
                    )}
                  </HeatGraph.Grid>
                </div>
              </div>

              <div className="text-muted-foreground mt-3 flex items-center justify-end gap-1.5 text-[10px]">
                <span>少</span>
                <HeatGraph.Legend>
                  {() => <HeatGraph.LegendLevel className="size-[11px] rounded-[3px]" />}
                </HeatGraph.Legend>
                <span>多</span>
              </div>

              <HeatGraph.Tooltip side="top" sideOffset={6}>
                {({ cell }) => (
                  <div className="bg-popover text-popover-foreground border-border z-50 rounded-md border px-2.5 py-1.5 text-xs shadow-md">
                    <span className="font-medium tabular-nums">{cell.count}</span> 篇文章 ·{" "}
                    {formatDate(cell.date.toISOString().slice(0, 10))}
                  </div>
                )}
              </HeatGraph.Tooltip>
            </HeatGraph.Root>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
