"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts"

import {
  Card,
  CardAction,
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { DashboardDistributionItem } from "@/lib/api"
import { VIZ } from "../metrics-utils"

const chartConfig = {
  count: { label: "文章数", color: VIZ.slot1 },
} satisfies ChartConfig

type DistributionView = "knowledgeBases" | "tags"

type DistributionChartProps = {
  knowledgeBases: DashboardDistributionItem[]
  tags: DashboardDistributionItem[]
  loading?: boolean
}

function truncate(label: string, max = 12) {
  return label.length > max ? `${label.slice(0, max)}…` : label
}

export function DistributionChart({ knowledgeBases, tags, loading }: DistributionChartProps) {
  const [view, setView] = React.useState<DistributionView>("knowledgeBases")
  const source = view === "knowledgeBases" ? knowledgeBases : tags
  const data = source.map((item) => ({ ...item, short: truncate(item.label) }))
  const hasData = data.length > 0

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>内容分布</CardTitle>
        <CardDescription>
          {view === "knowledgeBases" ? "各知识库的文章数量" : "标签使用频次 Top 8"}
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => value && setView(value as DistributionView)}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="knowledgeBases" className="px-3">
              知识库
            </ToggleGroupItem>
            <ToggleGroupItem value="tags" className="px-3">
              标签
            </ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : hasData ? (
          <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
            {/* 名义类别单色即可；条长已经表达大小，不再用深浅重复编码 */}
            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 32 }}>
              <CartesianGrid horizontal={false} strokeOpacity={0.5} />
              <XAxis type="number" hide />
              <YAxis
                dataKey="short"
                type="category"
                tickLine={false}
                axisLine={false}
                width={92}
                tick={{ fontSize: 12 }}
              />
              <ChartTooltip cursor={{ fillOpacity: 0.08 }} content={<ChartTooltipContent indicator="line" />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} barSize={18}>
                {/* 数值直接标在条端，不必悬停也能读 */}
                <LabelList
                  dataKey="count"
                  position="right"
                  offset={8}
                  className="fill-foreground"
                  fontSize={11}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="text-muted-foreground flex h-[240px] items-center justify-center text-sm">
            暂无数据
          </div>
        )}
      </CardContent>
    </Card>
  )
}
