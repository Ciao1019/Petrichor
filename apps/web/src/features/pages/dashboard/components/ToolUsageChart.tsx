"use client"

import { Wrench } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardToolStat } from "@/lib/api"
import { VIZ, formatCompact, formatDuration } from "../metrics-utils"

type ToolUsageChartProps = {
  items: DashboardToolStat[]
  windowDays: number
  loading?: boolean
}

/**
 * 工具名是无序的名义类别，所以所有条统一用槽位 1 的颜色——
 * 按数值深浅上色只是把条长重复编码一遍，白白浪费身份通道。
 */
export function ToolUsageChart({ items, windowDays, loading }: ToolUsageChartProps) {
  const max = Math.max(0, ...items.map((item) => item.count))
  const totalCalls = items.reduce((sum, item) => sum + item.count, 0)

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>助手工具调用</CardTitle>
        <CardDescription>
          近 {windowDays} 天共 <span className="text-foreground font-medium">{formatCompact(totalCalls)}</span> 次工具调用
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : items.length === 0 ? (
          <div className="text-muted-foreground flex h-[240px] flex-col items-center justify-center gap-2 text-sm">
            <Wrench className="size-6 opacity-40" />
            近 {windowDays} 天还没有工具调用
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => {
              const failed = item.count - item.okCount
              return (
                <li key={item.name} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs">{item.name}</span>
                    {/* 直接标注数值：不靠 tooltip 才能读出大小 */}
                    <span className="shrink-0 text-xs tabular-nums">
                      <span className="font-medium">{formatCompact(item.count)}</span>
                      <span className="text-muted-foreground ml-1.5">
                        {formatDuration(item.avgMs)}
                      </span>
                    </span>
                  </div>
                  <div className="bg-muted flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-l-full"
                      style={{
                        width: `${max > 0 ? (item.okCount / max) * 100 : 0}%`,
                        background: VIZ.slot1,
                      }}
                    />
                    {failed > 0 ? (
                      <div
                        className="h-full"
                        style={{
                          width: `${max > 0 ? (failed / max) * 100 : 0}%`,
                          background: VIZ.critical,
                        }}
                      />
                    ) : null}
                  </div>
                  {failed > 0 ? (
                    <span className="text-[11px] tabular-nums" style={{ color: VIZ.critical }}>
                      失败 {failed} 次
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
