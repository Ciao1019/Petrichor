"use client"

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
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { DashboardGrowthPoint } from "@/lib/api"
import { VIZ, formatAxisTick, formatCompact, formatMonth } from "../metrics-utils"

const articleConfig = {
  articles: { label: "累计文章", color: VIZ.slot1 },
} satisfies ChartConfig

const wordConfig = {
  words: { label: "累计字数", color: VIZ.slot2 },
} satisfies ChartConfig

type GrowthChartProps = {
  data: DashboardGrowthPoint[]
  loading?: boolean
}

/**
 * 篇数和字数量级差了几个数量级，共用一张图必然要双 Y 轴——那会凭空造出
 * 一条并不存在的相关性。这里改成上下两张小图各自独立纵轴，只共用月份横轴。
 */
function GrowthPane({
  data,
  dataKey,
  config,
  color,
  showAxis,
}: {
  data: DashboardGrowthPoint[]
  dataKey: "articles" | "words"
  config: ChartConfig
  color: string
  showAxis: boolean
}) {
  return (
    <ChartContainer
      config={config}
      className={`aspect-auto w-full ${showAxis ? "h-[118px]" : "h-[96px]"}`}
    >
      <AreaChart data={data} margin={{ left: 4, right: 8, top: 6 }}>
        <defs>
          <linearGradient id={`growth-fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.45} />
            <stop offset="95%" stopColor={color} stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeOpacity={0.5} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          hide={!showAxis}
          tickFormatter={formatMonth}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickMargin={4}
          tickCount={3}
          allowDecimals={false}
          tickFormatter={(value) => formatAxisTick(Number(value))}
        />
        <ChartTooltip
          cursor={{ strokeOpacity: 0.4 }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `${String(value)}`}
              formatter={(value, name) => [`${formatCompact(Number(value))} `, name as string]}
              indicator="line"
            />
          }
        />
        <Area
          dataKey={dataKey}
          type="monotone"
          fill={`url(#growth-fill-${dataKey})`}
          stroke={color}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}

export function GrowthChart({ data, loading }: GrowthChartProps) {
  const latest = data[data.length - 1]

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>内容沉淀</CardTitle>
        <CardDescription>
          近 12 个月累计，当前
          <span className="text-foreground font-medium"> {formatCompact(latest?.articles ?? 0)} </span>
          篇 ·
          <span className="text-foreground font-medium"> {formatCompact(latest?.words ?? 0)} </span>
          字
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        {loading ? (
          <Skeleton className="h-[214px] w-full" />
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 px-2 text-xs">
              <span className="size-2 rounded-full" style={{ background: VIZ.slot1 }} aria-hidden />
              <span className="text-muted-foreground">累计文章（篇）</span>
            </div>
            <GrowthPane
              data={data}
              dataKey="articles"
              config={articleConfig}
              color={VIZ.slot1}
              showAxis={false}
            />
            <div className="mt-1 flex items-center gap-1.5 px-2 text-xs">
              <span className="size-2 rounded-full" style={{ background: VIZ.slot2 }} aria-hidden />
              <span className="text-muted-foreground">累计字数（字）</span>
            </div>
            <GrowthPane
              data={data}
              dataKey="words"
              config={wordConfig}
              color={VIZ.slot2}
              showAxis
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
