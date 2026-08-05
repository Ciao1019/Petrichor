"use client"

import * as React from "react"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { DashboardKpiTile, DashboardStatItem } from "@/lib/api"
import { VIZ, formatCompact, sparkPath } from "../metrics-utils"

type KpiCardsProps = {
  primary?: DashboardKpiTile[]
  secondary?: DashboardStatItem[]
  loading?: boolean
}

// 槽位顺序固定：同一指标在任何时候都是同一个颜色，筛选或增减卡片都不会换色
const TILE_COLORS = [VIZ.slot1, VIZ.slot2, VIZ.slot3, VIZ.slot4]

/** 数字滚动到位；开启「减少动态效果」时直接落到终值 */
function useCountUp(value: number, duration = 700) {
  const [display, setDisplay] = React.useState(value)
  const fromRef = React.useRef(value)

  React.useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const from = fromRef.current
    if (reduceMotion || from === value) {
      fromRef.current = value
      setDisplay(value)
      return
    }
    let frame = 0
    const start = performance.now()
    const tick = (time: number) => {
      const progress = Math.min(1, (time - start) / duration)
      // easeOutCubic：起步快、收尾稳，读数不会在末尾跳动
      const eased = 1 - (1 - progress) ** 3
      setDisplay(Math.round(from + (value - from) * eased))
      if (progress < 1) frame = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, duration])

  return display
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-0.5 text-xs">
        <Minus className="size-3" />
        无对比基数
      </span>
    )
  }
  const rising = delta > 0
  const flat = Math.abs(delta) < 0.05
  if (flat) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-0.5 text-xs tabular-nums">
        <Minus className="size-3" />
        持平
      </span>
    )
  }
  const Icon = rising ? ArrowUpRight : ArrowDownRight
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums"
      style={{ color: rising ? VIZ.good : VIZ.critical }}
    >
      <Icon className="size-3" />
      {Math.abs(delta).toFixed(Math.abs(delta) >= 100 ? 0 : 1)}%
    </span>
  )
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const width = 96
  const height = 28
  const path = sparkPath(values, width, height)
  const hasSignal = values.some((value) => value > 0)
  if (!path || !hasSignal) {
    return <div className="border-border/60 h-7 w-24 border-b border-dashed" aria-hidden />
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-7 w-24 overflow-visible"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={`${path} L${width} ${height} L0 ${height} Z`} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function KpiTile({ tile, color }: { tile: DashboardKpiTile; color: string }) {
  const display = useCountUp(tile.value)

  return (
    <Card className="@container/kpi relative gap-0 overflow-hidden p-4">
      {/* 顶部色条即该指标的身份标识，与走势线同色 */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ background: color }} />
      <div className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground text-sm">{tile.label}</span>
        <Sparkline values={tile.spark} color={color} />
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        {/* 大号读数用比例数字：等宽数字在展示字号下会显得松散 */}
        <span className="text-2xl font-semibold @[200px]/kpi:text-3xl">
          {formatCompact(display)}
        </span>
        {tile.unit ? <span className="text-muted-foreground text-xs">{tile.unit}</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <DeltaBadge delta={tile.delta} />
        <span className="text-muted-foreground text-xs tabular-nums">
          近 7 天 +{formatCompact(tile.current)}
        </span>
      </div>
    </Card>
  )
}

export function KpiCards({ primary, secondary, loading }: KpiCardsProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[124px] w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[76px] w-full rounded-xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(primary ?? []).map((tile, index) => (
          <KpiTile key={tile.key} tile={tile} color={TILE_COLORS[index % TILE_COLORS.length]} />
        ))}
      </div>

      {secondary && secondary.length > 0 ? (
        <Card className="gap-0 p-0">
          <dl className="divide-border/60 grid grid-cols-2 divide-y sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-4 xl:grid-cols-7 [&>div]:sm:border-l [&>div:first-child]:sm:border-l-0">
            {secondary.map((item, index) => (
              <div
                key={item.key}
                className={cn(
                  "border-border/60 flex flex-col gap-0.5 px-4 py-3",
                  index % 2 === 1 && "border-l sm:border-l",
                )}
              >
                <dt className="text-muted-foreground truncate text-xs">{item.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatCompact(item.value)}</dd>
                {item.hint ? (
                  <span className="text-muted-foreground truncate text-[11px]">{item.hint}</span>
                ) : null}
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
    </div>
  )
}
