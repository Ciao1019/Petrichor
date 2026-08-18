"use client"

import { FileStack, Inbox } from "@/components/iconimate"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { DashboardOverviewResponse, DashboardStatusBucket } from "@/lib/api"
import { formatBytes, formatCompact, statusMeta } from "../metrics-utils"

type PipelineStatusPanelProps = {
  pipeline?: DashboardOverviewResponse["pipeline"]
  loading?: boolean
}

/** 状态既有语义又有数值，条形 + 图标 + 文字三重编码，颜色只是辅助 */
function StatusBar({ buckets, total }: { buckets: DashboardStatusBucket[]; total: number }) {
  if (total === 0) {
    return <div className="bg-muted h-2 w-full rounded-full" />
  }
  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
      {buckets.map((bucket) => (
        <div
          key={bucket.status}
          className="h-full first:rounded-l-full last:rounded-r-full"
          style={{
            width: `${(bucket.count / total) * 100}%`,
            background: statusMeta(bucket.status).color,
          }}
        />
      ))}
    </div>
  )
}

function StatusList({ buckets }: { buckets: DashboardStatusBucket[] }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1.5">
      {buckets.map((bucket) => {
        const meta = statusMeta(bucket.status)
        return (
          <div key={bucket.status} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ background: meta.color }}
            />
            <dt className="text-muted-foreground text-xs">{meta.label}</dt>
            <dd className="text-xs font-medium tabular-nums">{formatCompact(bucket.count)}</dd>
          </div>
        )
      })}
    </dl>
  )
}

export function PipelineStatusPanel({ pipeline, loading }: PipelineStatusPanelProps) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>处理流水线</CardTitle>
        <CardDescription>文档解析与文档导入任务的执行状态</CardDescription>
      </CardHeader>
      <CardContent>
        {loading || !pipeline ? (
          <Skeleton className="h-[196px] w-full" />
        ) : (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <FileStack className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1 text-sm font-medium">文档库</span>
                <span className="text-sm tabular-nums">
                  {formatCompact(pipeline.documentTotal)} 份
                </span>
              </div>
              <StatusBar buckets={pipeline.documents} total={pipeline.documentTotal} />
              {pipeline.documentTotal > 0 ? (
                <StatusList buckets={pipeline.documents} />
              ) : (
                <span className="text-muted-foreground text-xs">还没有上传文档</span>
              )}
              <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs tabular-nums">
                <span>{formatCompact(pipeline.documentPages)} 页</span>
                <span>{formatBytes(pipeline.documentBytes)}</span>
              </div>
            </section>

            <section className="border-border/60 flex flex-col gap-2.5 border-t pt-4">
              <div className="flex items-center gap-2">
                <Inbox className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1 text-sm font-medium">导入任务</span>
                <span className="text-sm tabular-nums">
                  {formatCompact(pipeline.importTotal)} 个
                </span>
              </div>
              <StatusBar buckets={pipeline.imports} total={pipeline.importTotal} />
              {pipeline.importTotal > 0 ? (
                <StatusList buckets={pipeline.imports} />
              ) : (
                <span className="text-muted-foreground text-xs">还没有导入任务</span>
              )}
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
