"use client"

import * as React from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardRhythmCell } from "@/lib/api"
import { HEAT_SCALE, bucketRhythm, heatLevel, shiftRhythmToLocal } from "../metrics-utils"

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
const BAND_HOURS = 3

type WritingRhythmGridProps = {
  cells: DashboardRhythmCell[]
  loading?: boolean
}

/**
 * 创作节律：星期 × 时段。
 *
 * 服务端给的是 UTC 分桶，这里按浏览器时区整体旋转——时区平移在
 * 「星期×小时」环形空间里是精确变换，所以服务端不需要知道用户时区。
 */
export function WritingRhythmGrid({ cells, loading }: WritingRhythmGridProps) {
  const bands = React.useMemo(() => {
    const offsetMinutes = -new Date().getTimezoneOffset()
    return bucketRhythm(shiftRhythmToLocal(cells, offsetMinutes), BAND_HOURS)
  }, [cells])

  const max = React.useMemo(() => Math.max(0, ...bands.map((band) => band.count)), [bands])
  const peak = React.useMemo(
    () => (max > 0 ? bands.reduce((best, band) => (band.count > best.count ? band : best)) : null),
    [bands, max],
  )
  const columns = Math.ceil(24 / BAND_HOURS)

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>创作节律</CardTitle>
        <CardDescription>
          {peak ? (
            <>
              最活跃时段是
              <span className="text-foreground font-medium">
                {" "}
                {WEEKDAY_LABELS[peak.weekday]} {String(peak.startHour).padStart(2, "0")}–
                {String(peak.endHour).padStart(2, "0")} 点
              </span>
            </>
          ) : (
            "过去一年按星期与时段的发布分布"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[196px] w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1.5">
              <div className="flex shrink-0 flex-col gap-0.5 pt-[18px]">
                {WEEKDAY_LABELS.map((label) => (
                  <div
                    key={label}
                    className="text-muted-foreground flex h-5 items-center text-[10px] leading-none"
                  >
                    {label}
                  </div>
                ))}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className="mb-1 grid gap-0.5"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                  {Array.from({ length: columns }).map((_, index) => (
                    <span
                      key={index}
                      className="text-muted-foreground text-center text-[10px] leading-[14px] tabular-nums"
                    >
                      {String(index * BAND_HOURS).padStart(2, "0")}
                    </span>
                  ))}
                </div>
                <div
                  className="grid gap-0.5"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                  {bands.map((band) => (
                    <div
                      key={`${band.weekday}-${band.band}`}
                      className="hover:ring-ring/60 h-5 rounded-[3px] transition-shadow hover:ring-1"
                      style={{ background: HEAT_SCALE[heatLevel(band.count, max)] }}
                      title={`${WEEKDAY_LABELS[band.weekday]} ${String(band.startHour).padStart(2, "0")}:00–${String(band.endHour).padStart(2, "0")}:00 · ${band.count} 篇`}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="text-muted-foreground flex items-center justify-end gap-1.5 text-[10px]">
              <span>少</span>
              {HEAT_SCALE.map((color) => (
                <span
                  key={color}
                  className="size-[11px] rounded-[3px]"
                  style={{ background: color }}
                  aria-hidden
                />
              ))}
              <span>多</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
