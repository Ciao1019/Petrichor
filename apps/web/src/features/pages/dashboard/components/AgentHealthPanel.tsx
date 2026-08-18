"use client"

import { AlertTriangle, CheckCircle2, Gauge, XCircle } from "@/components/iconimate"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

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
import type { DashboardOverviewResponse } from "@/lib/api"
import { VIZ, formatAxisTick, formatCompact, formatDay, formatDuration, sparkPath } from "../metrics-utils"

// 这两条序列的含义就是「成功 / 失败」，因此走状态色而不是分类色，且都配了图标与文字
const chartConfig = {
  ok: { label: "成功", color: VIZ.good },
  errors: { label: "失败", color: VIZ.critical },
} satisfies ChartConfig

type AgentHealthPanelProps = {
  agent?: DashboardOverviewResponse["agent"]
  loading?: boolean
}

function StatusRow({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  label: string
  value: number
  color: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0" style={{ color }} />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="text-sm font-medium tabular-nums">{formatCompact(value)}</span>
    </div>
  )
}

export function AgentHealthPanel({ agent, loading }: AgentHealthPanelProps) {
  if (loading || !agent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent 接口健康</CardTitle>
          <CardDescription>开放接口的调用量、成功率与耗时</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    )
  }

  const daily = agent.daily.map((point) => ({
    date: point.date,
    ok: Math.max(0, point.count - point.errors),
    errors: point.errors,
    avgMs: point.avgMs,
  }))
  const hasCalls = agent.totalCalls > 0
  const latencySpark = daily.map((point) => point.avgMs)

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Agent 接口健康</CardTitle>
        <CardDescription>开放接口近 {agent.windowDays} 天的调用量、成功率与耗时</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasCalls ? (
          <div className="text-muted-foreground flex h-[220px] flex-col items-center justify-center gap-2 text-sm">
            <Gauge className="size-6 opacity-40" />
            近 {agent.windowDays} 天没有接口调用记录
          </div>
        ) : (
          <div className="flex flex-col gap-5 xl:flex-row">
            <div className="flex shrink-0 flex-col gap-4 xl:w-56">
              <div>
                <div className="text-muted-foreground text-xs">成功率</div>
                <div className="mt-1 text-3xl font-semibold">
                  {agent.successRate.toFixed(agent.successRate >= 99.95 ? 0 : 1)}
                  <span className="text-muted-foreground ml-0.5 text-base font-normal">%</span>
                </div>
                {/* 单一比率对基准 → 用同色阶的进度条，而不是两片饼 */}
                <div className="bg-muted mt-2 h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, agent.successRate))}%`,
                      background: VIZ.good,
                    }}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <StatusRow icon={CheckCircle2} label="成功" value={agent.successCalls} color={VIZ.good} />
                <StatusRow
                  icon={AlertTriangle}
                  label="客户端错误 4xx"
                  value={agent.clientErrors}
                  color={VIZ.warning}
                />
                <StatusRow
                  icon={XCircle}
                  label="服务端错误 5xx"
                  value={agent.serverErrors}
                  color={VIZ.critical}
                />
              </div>

              <div className="border-border/60 flex flex-col gap-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs">平均耗时</span>
                  <span className="text-sm font-medium tabular-nums">
                    {formatDuration(agent.avgDurationMs)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs">峰值耗时</span>
                  <span className="text-sm font-medium tabular-nums">
                    {formatDuration(agent.maxDurationMs)}
                  </span>
                </div>
                {/* 耗时与调用量量级不同，单独一条走势线，不跟柱图共用纵轴 */}
                <svg
                  viewBox="0 0 160 24"
                  className="h-6 w-full overflow-visible"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <path
                    d={sparkPath(latencySpark, 160, 24)}
                    fill="none"
                    stroke={VIZ.slot7}
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <span className="text-muted-foreground text-[11px]">
                  每日平均耗时走势（{agent.windowDays} 天）
                </span>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
                <BarChart data={daily} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.5} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
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
                    cursor={{ fillOpacity: 0.08 }}
                    content={
                      <ChartTooltipContent labelFormatter={(value) => formatDay(String(value))} />
                    }
                  />
                  <Bar dataKey="ok" stackId="calls" fill="var(--color-ok)" radius={[0, 0, 2, 2]} />
                  <Bar
                    dataKey="errors"
                    stackId="calls"
                    fill="var(--color-errors)"
                    radius={[2, 2, 0, 0]}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </BarChart>
              </ChartContainer>
            </div>
          </div>
        )}

        {agent.topPaths.length > 0 ? (
          <div className="border-border/60 mt-5 border-t pt-4">
            <div className="text-muted-foreground mb-2 text-xs">调用最多的接口</div>
            {/* 表格本身就是这张卡的「表格视图」：所有数值都不依赖颜色 */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left text-xs">
                    <th className="pb-2 font-normal">接口</th>
                    <th className="pb-2 text-right font-normal">调用</th>
                    <th className="pb-2 text-right font-normal">平均耗时</th>
                    <th className="pb-2 text-right font-normal">错误</th>
                  </tr>
                </thead>
                <tbody className="divide-border/60 divide-y">
                  {agent.topPaths.map((item) => (
                    <tr key={`${item.method}-${item.path}`}>
                      <td className="py-1.5 pr-3">
                        <span className="text-muted-foreground mr-1.5 text-[11px] font-medium">
                          {item.method}
                        </span>
                        <span className="font-mono text-xs">{item.path}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatCompact(item.count)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatDuration(item.avgMs)}
                      </td>
                      <td
                        className="py-1.5 text-right tabular-nums"
                        style={{ color: item.errorCount > 0 ? VIZ.critical : undefined }}
                      >
                        {item.errorCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
