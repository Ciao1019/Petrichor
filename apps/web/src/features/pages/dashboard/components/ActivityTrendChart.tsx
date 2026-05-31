"use client"

import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { DashboardTrendPoint } from "@/lib/api"

const chartConfig = {
  article: { label: "文章", color: "var(--chart-1)" },
  qa: { label: "问答", color: "var(--chart-2)" },
  agent: { label: "Agent", color: "var(--chart-3)" },
} satisfies ChartConfig

type ActivityTrendChartProps = {
  data: DashboardTrendPoint[]
  loading?: boolean
}

function formatDay(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function ActivityTrendChart({ data, loading }: ActivityTrendChartProps) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>活动趋势</CardTitle>
        <CardDescription>近 30 天文章、问答与 Agent 调用</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {loading ? (
          <div className="bg-muted/50 h-[240px] w-full animate-pulse rounded-md" />
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
            <AreaChart data={data}>
              <defs>
                {(["article", "qa", "agent"] as const).map((key) => (
                  <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.8} />
                    <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.08} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
                tickFormatter={formatDay}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent labelFormatter={(value) => formatDay(String(value))} indicator="dot" />}
              />
              <Area dataKey="article" type="natural" fill="url(#fill-article)" stroke="var(--color-article)" stackId="a" />
              <Area dataKey="qa" type="natural" fill="url(#fill-qa)" stroke="var(--color-qa)" stackId="a" />
              <Area dataKey="agent" type="natural" fill="url(#fill-agent)" stroke="var(--color-agent)" stackId="a" />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
