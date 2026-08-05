"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { DashboardTrendPoint } from "@/lib/api"
import { VIZ, formatAxisTick, formatCompact, formatDay } from "../metrics-utils"

const chartConfig = {
  article: { label: "文章", color: VIZ.slot1 },
  qa: { label: "助手对话", color: VIZ.slot2 },
  agent: { label: "Agent 调用", color: VIZ.slot3 },
} satisfies ChartConfig

const SERIES = ["article", "qa", "agent"] as const

type ActivityTrendChartProps = {
  data: DashboardTrendPoint[]
  rangeLabel: string
  loading?: boolean
}

export function ActivityTrendChart({ data, rangeLabel, loading }: ActivityTrendChartProps) {
  const total = React.useMemo(
    () => data.reduce((sum, point) => sum + point.total, 0),
    [data],
  )

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>活动趋势</CardTitle>
        <CardDescription>
          近 {rangeLabel}共 <span className="text-foreground font-medium">{formatCompact(total)}</span> 次活动
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                {SERIES.map((key) => (
                  <linearGradient key={key} id={`trend-fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.5} />
                    <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} strokeOpacity={0.5} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
                tickFormatter={formatDay}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={46}
                tickMargin={4}
                allowDecimals={false}
                tickFormatter={(value) => formatAxisTick(Number(value))}
              />
              <ChartTooltip
                cursor={{ strokeOpacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDay(String(value))}
                    indicator="dot"
                  />
                }
              />
              {/* 每层带 2px 同色描边，堆叠区之间不靠边框而靠这条线分隔 */}
              {SERIES.map((key) => (
                <Area
                  key={key}
                  dataKey={key}
                  type="monotone"
                  fill={`url(#trend-fill-${key})`}
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  stackId="activity"
                />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
