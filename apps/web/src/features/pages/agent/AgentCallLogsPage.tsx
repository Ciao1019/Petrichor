"use client"

import * as React from "react"
import {
  AlertCircle,
  Clock,
  Eye,
  FileText,
  Globe,
  KeyRound,
  Loader2,
  Network,
  RefreshCw,
} from "@/components/iconimate"
import { toast } from "sonner"

import { agentApi, type AgentCallLogItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { AppPagination } from "@/components/app-pagination"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import { formatDateTime, formatPayload, normalizeAxiosErrorMessage, parseMcpToolFromUserAgent } from "./agent-shared"
import { AgentPageHeader } from "./agent-ui"

const PAGE_SIZE = 12

export function AgentCallLogsPage() {
  const [logs, setLogs] = React.useState<AgentCallLogItem[]>([])
  const [logsLoading, setLogsLoading] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [activeLog, setActiveLog] = React.useState<AgentCallLogItem | null>(null)

  const fetchLogs = React.useCallback(async () => {
    setLogsLoading(true)
    try {
      const res = await agentApi.listCallLogs({ limit: 100 })
      setLogs(res.data.items)
    } catch (e) {
      toast.error(normalizeAxiosErrorMessage(e, "调用日志加载失败"))
    } finally {
      setLogsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchLogs()
  }, [fetchLogs])

  const filteredLogs = React.useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return logs
    return logs.filter((log) => {
      return (
        log.path.toLowerCase().includes(k) ||
        log.method.toLowerCase().includes(k) ||
        log.apiKeyPrefix.toLowerCase().includes(k) ||
        (log.ip ?? "").toLowerCase().includes(k)
      )
    })
  }, [logs, keyword])

  const pageCount = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)

  // 过滤条件或数据变化时回到第一页
  React.useEffect(() => {
    setPage(1)
  }, [keyword, logs])

  const pagedLogs = React.useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredLogs.slice(start, start + PAGE_SIZE)
  }, [filteredLogs, currentPage])

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <AgentPageHeader
        icon={FileText}
        title="外部调用日志"
        description="展示最近 100 条 Agent API 调用（含 MCP 工具调用），包含接口、状态与耗时。点击「详情」查看完整入参/出参。"
      />

      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-base">调用记录</CardTitle>
            <CardDescription>共 {filteredLogs.length} 条记录</CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按路径 / 方法 / IP / Key 过滤"
              className="w-full sm:w-72"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void fetchLogs()} disabled={logsLoading}>
              {logsLoading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">时间</TableHead>
                  <TableHead>接口</TableHead>
                  <TableHead className="w-[90px]">状态</TableHead>
                  <TableHead className="w-[90px] text-right">耗时</TableHead>
                  <TableHead className="w-[180px]">Key / IP</TableHead>
                  <TableHead className="w-[64px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsLoading && logs.length === 0 ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <TableRow key={`log-skeleton-${index}`} className="animate-pulse">
                      <TableCell><div className="h-4 w-28 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-48 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-12 rounded bg-muted" /></TableCell>
                      <TableCell><div className="ml-auto h-4 w-14 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-24 rounded bg-muted" /></TableCell>
                      <TableCell><div className="ml-auto h-8 w-8 rounded bg-muted" /></TableCell>
                    </TableRow>
                  ))
                ) : pagedLogs.length > 0 ? (
                  pagedLogs.map((log) => {
                    const isFailure = log.statusCode >= 400
                    const mcpTool = parseMcpToolFromUserAgent(log.userAgent)
                    return (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(log.createdAt)}
                        </TableCell>
                        <TableCell className="min-w-0">
                          <div className="flex items-center gap-2">
                            {mcpTool ? (
                              <Badge
                                variant="outline"
                                className="shrink-0 border-primary/25 bg-primary/5 font-mono text-[11px] font-normal text-primary"
                                title={`MCP 工具：${mcpTool}`}
                              >
                                MCP
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                                {log.method}
                              </Badge>
                            )}
                            <span className="truncate font-mono text-xs" title={mcpTool ?? log.path}>
                              {mcpTool ?? log.path}
                            </span>
                          </div>
                          {log.errorMessage ? (
                            <div className="mt-1 truncate text-[11px] text-destructive" title={log.errorMessage}>
                              {log.errorMessage}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              "border font-normal",
                              isFailure
                                ? "bg-destructive/10 text-destructive border-destructive/30"
                                : "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800",
                            )}
                          >
                            {isFailure ? "失败" : "成功"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-mono text-xs">{log.durationMs}ms</span>
                        </TableCell>
                        <TableCell className="space-y-1">
                          <div className="truncate font-mono text-[11px] text-muted-foreground" title={log.apiKeyPrefix}>
                            {log.apiKeyPrefix}
                          </div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground" title={log.ip || "-"}>
                            {log.ip || "-"}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setActiveLog(log)}
                            aria-label="查看详情"
                          >
                            <Eye className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      暂无外部调用记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {filteredLogs.length > 0 ? (
            <AppPagination
              page={currentPage - 1}
              totalPages={pageCount}
              total={filteredLogs.length}
              pageSize={PAGE_SIZE}
              onChange={(nextPageIndex) => setPage(nextPageIndex + 1)}
            />
          ) : null}
        </CardContent>
      </Card>

      <CallLogDetailDialog log={activeLog} onClose={() => setActiveLog(null)} />
    </div>
  )
}

function CallLogDetailDialog({
  log,
  onClose,
}: {
  log: AgentCallLogItem | null
  onClose: () => void
}) {
  const isFailure = log ? log.statusCode >= 400 : false
  const mcpTool = log ? parseMcpToolFromUserAgent(log.userAgent) : null

  return (
    <Dialog open={Boolean(log)} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        className="max-w-3xl gap-0 overflow-hidden p-0"
        showCloseButton
      >
        <DialogHeader className="sr-only">
          <DialogTitle>调用详情</DialogTitle>
        </DialogHeader>
        {log ? (
          <div className="flex max-h-[85vh] flex-col">
            <div className="border-b bg-muted/30 px-6 py-5 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {log.method}
                </Badge>
                {mcpTool ? (
                  <Badge
                    variant="outline"
                    className="border-primary/25 bg-primary/5 font-mono text-xs font-normal text-primary"
                  >
                    MCP · {mcpTool}
                  </Badge>
                ) : null}
                <span className="break-all font-mono text-sm text-foreground">{log.path}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "ml-auto border font-normal",
                    isFailure
                      ? "bg-destructive/10 text-destructive border-destructive/30"
                      : "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800",
                  )}
                >
                  {isFailure ? `失败 · ${log.statusCode}` : `成功 · ${log.statusCode}`}
                </Badge>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5" />
                {formatDateTime(log.createdAt)}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <MetricTile icon={Clock} label="耗时" value={`${log.durationMs}ms`} />
                <MetricTile icon={KeyRound} label="API Key" value={log.apiKeyPrefix} mono />
                <MetricTile icon={Network} label="IP" value={log.ip || "-"} mono />
              </div>

              {log.errorMessage ? (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="break-all">{log.errorMessage}</span>
                </div>
              ) : null}

              {log.userAgent ? (
                <>
                  <Separator className="my-4" />
                  <div className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Globe className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-all">{log.userAgent}</span>
                  </div>
                </>
              ) : null}

              <Tabs defaultValue="request" className="mt-5 gap-3">
                <TabsList className="w-full">
                  <TabsTrigger value="request" className="flex-1">入参</TabsTrigger>
                  <TabsTrigger value="response" className="flex-1">出参</TabsTrigger>
                </TabsList>
                <TabsContent value="request">
                  <PayloadCodeBlock value={log.request} fallback={log.requestText} />
                </TabsContent>
                <TabsContent value="response">
                  <PayloadCodeBlock value={log.response} fallback={log.responseText} />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function MetricTile({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card/30 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className={cn("mt-1 truncate text-sm font-medium", mono && "font-mono")} title={value}>
        {value}
      </div>
    </div>
  )
}

function PayloadCodeBlock({
  value,
  fallback,
}: {
  value: unknown
  fallback?: string | null
}) {
  const rendered = formatPayload(value, fallback)
  const isJson = typeof value === "object" && value !== null
  return (
    <CodeBlock className="max-h-80 overflow-auto">
      <CodeBlockCode code={rendered} language={isJson ? "json" : "text"} showLineNumbers={false} />
    </CodeBlock>
  )
}
