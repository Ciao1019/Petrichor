"use client"

import * as React from "react"
import { Activity, RefreshCw } from "@/components/iconimate"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { RANGE_OPTIONS, type RangeValue, relativeTime } from "../metrics-utils"

type MetricsHeaderProps = {
  range: RangeValue
  onRangeChange: (range: RangeValue) => void
  onRefresh: () => void
  generatedAt?: string
  loading?: boolean
}

/** 每秒走一次的本地时钟，给大屏一点「在线」的感觉 */
function useClock() {
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

export function MetricsHeader({
  range,
  onRangeChange,
  onRefresh,
  generatedAt,
  loading,
}: MetricsHeaderProps) {
  const now = useClock()

  return (
    <div className="border-border/60 from-primary/[0.07] relative overflow-hidden rounded-xl border bg-gradient-to-br via-transparent to-transparent p-4 md:p-5">
      {/* 背景网格：纯装饰，不承载任何数据含义 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
              <Activity className="size-4" />
            </span>
            <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">
              数据总览
            </h1>
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm">
            知识库、助手与 Agent 接口的运行全景
            {generatedAt ? (
              <>
                <span className="mx-1.5 opacity-40">·</span>
                数据更新于 {relativeTime(generatedAt)}
              </>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="border-border/60 bg-card/60 hidden items-center gap-2 rounded-lg border px-3 py-1.5 sm:flex">
            <span className="relative flex size-1.5">
              <span className="bg-viz-good absolute inline-flex size-full animate-ping rounded-full opacity-60" />
              <span className="bg-viz-good relative inline-flex size-1.5 rounded-full" />
            </span>
            <span className="text-sm font-medium tabular-nums">
              {now.toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
          </div>

          <ToggleGroup
            type="single"
            value={String(range)}
            onValueChange={(value) => value && onRangeChange(Number(value) as RangeValue)}
            variant="outline"
            size="sm"
          >
            {RANGE_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={String(option.value)} className="px-3">
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </div>
    </div>
  )
}
