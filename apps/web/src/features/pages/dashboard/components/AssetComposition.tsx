"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardDistributionItem } from "@/lib/api"
import { VIZ, formatCompact } from "../metrics-utils"

// 槽位按资产类型固定绑定，某类为 0 被过滤掉时其余颜色不会平移
const ASSET_COLORS: Record<string, string> = {
  文章: VIZ.slot1,
  "Wiki 页面": VIZ.slot2,
  文档: VIZ.slot3,
  图谱节点: VIZ.slot4,
}

type AssetCompositionProps = {
  items: DashboardDistributionItem[]
  loading?: boolean
}

/**
 * 部分-整体用横向堆叠条，而不是饼图/环形图：
 * 数值接近时扇形角度几乎读不出差别，条形加直接标注才是能读的形式。
 */
export function AssetComposition({ items, loading }: AssetCompositionProps) {
  const total = items.reduce((sum, item) => sum + item.count, 0)

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>知识资产构成</CardTitle>
        <CardDescription>
          共 <span className="text-foreground font-medium">{formatCompact(total)}</span> 个条目
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[196px] w-full" />
        ) : total === 0 ? (
          <div className="text-muted-foreground flex h-[196px] items-center justify-center text-sm">
            暂无数据
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* 段与段之间留 2px 底色缝隙做分隔，而不是给每段描边 */}
            <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
              {items.map((item) => (
                <div
                  key={item.label}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{
                    width: `${(item.count / total) * 100}%`,
                    background: ASSET_COLORS[item.label] ?? VIZ.slot5,
                  }}
                  title={`${item.label} ${item.count}`}
                />
              ))}
            </div>

            {/* 图例即数值表：颜色不是读数的唯一通道 */}
            <dl className="flex flex-col gap-2.5">
              {items.map((item) => (
                <div key={item.label} className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ background: ASSET_COLORS[item.label] ?? VIZ.slot5 }}
                  />
                  <dt className="min-w-0 flex-1 truncate text-sm">{item.label}</dt>
                  <dd className="text-sm font-medium tabular-nums">{formatCompact(item.count)}</dd>
                  <span className="text-muted-foreground w-11 text-right text-xs tabular-nums">
                    {((item.count / total) * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
