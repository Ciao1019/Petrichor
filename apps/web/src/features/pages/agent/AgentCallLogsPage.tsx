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
  Workflow,
} from "lucide-react"
import { toast } from "sonner"

import { agentApi, type AgentCallLogItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import { formatDateTime, formatPayload, normalizeAxiosErrorMessage } from "./agent-shared"

const SOURCE_BADGE_CLASSES = [
  "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800",
  "bg-indigo-500/10 text-indigo-700 border-indigo-200 dark:text-indigo-400 dark:border-indigo-800",
  "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-800",
  "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-800",
  "bg-sky-500/10 text-sky-700 border-sky-200 dark:text-sky-400 dark:border-sky-800",
  "bg-rose-500/10 text-rose-700 border-rose-200 dark:text-rose-400 dark:border-rose-800",
  "bg-teal-500/10 text-teal-700 border-teal-200 dark:text-teal-400 dark:border-teal-800",
] as const

const KNOWN_SOURCE_INDEX: Record<string, number> = {
  codex: 1,
  "claude-code": 0,
  claude: 0,
  openclaw: 3,
  cursor: 4,
  "missing-source": 5,
}

function sourceBadgeClass(source: string) {
  const normalized = source.toLowerCase()
  const known = KNOWN_SOURCE_INDEX[normalized]
  if (typeof known === "number") return SOURCE_BADGE_CLASSES[known]
  const idx = Math.abs(hashString(normalized)) % SOURCE_BADGE_CLASSES.length
  return SOURCE_BADGE_CLASSES[idx]
}

function hashString(input: string) {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0
  }
  return hash
}

export function AgentCallLogsPage() {
  const [logs, setLogs] = React.useState<AgentCallLogItem[]>([])
  const [logsLoading, setLogsLoading] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")
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
        log.agentSource.toLowerCase().includes(k) ||
        (log.agentTool ?? "").toLowerCase().includes(k) ||
        log.path.toLowerCase().includes(k) ||
        log.method.toLowerCase().includes(k) ||
        log.apiKeyPrefix.toLowerCase().includes(k) ||
        (log.ip ?? "").toLowerCase().includes(k)
      )
    })
  }, [logs, keyword])

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <FileText className="size-6 text-primary" />
            外部调用日志
          </h1>
          <p className="text-sm text-muted-foreground">
            展示最近 100 条 Agent API 调用，包含调用来源、接口状态与耗时。点击「详情」查看完整入参/出参。
          </p>
        </div>
      </div>

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
              placeholder="按来源 / 路径 / IP / Key 过滤"
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">时间</TableHead>
                  <TableHead className="w-[180px]">来源</TableHead>
                  <TableHead>接口</TableHead>
                  <TableHead className="w-[110px]">状态</TableHead>
                  <TableHead className="w-[100px] text-right">耗时</TableHead>
                  <TableHead className="w-[160px]">Key / IP</TableHead>
                  <TableHead className="w-[80px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsLoading && logs.length === 0 ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <TableRow key={`log-skeleton-${index}`} className="animate-pulse">
                      <TableCell><div className="h-4 w-28 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-20 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-48 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-12 rounded bg-muted" /></TableCell>
                      <TableCell><div className="ml-auto h-4 w-14 rounded bg-muted" /></TableCell>
                      <TableCell><div className="h-4 w-24 rounded bg-muted" /></TableCell>
                      <TableCell><div className="ml-auto h-8 w-8 rounded bg-muted" /></TableCell>
                    </TableRow>
                  ))
                ) : filteredLogs.length > 0 ? (
                  filteredLogs.map((log) => {
                    const isFailure = log.statusCode >= 400
                    return (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(log.createdAt)}
                        </TableCell>
                        <TableCell className="space-y-1">
                          <Badge
                            variant="outline"
                            className={cn("border font-normal", sourceBadgeClass(log.agentSource))}
                          >
                            {log.agentSource}
                          </Badge>
                          {log.agentTool ? (
                            <div className="font-mono text-[11px] text-muted-foreground">{log.agentTool}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="font-mono text-[11px]">
                              {log.method}
                            </Badge>
                            <span className="break-all font-mono text-xs">{log.path}</span>
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
                          <div className="font-mono text-[11px] text-muted-foreground">{log.apiKeyPrefix}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">{log.ip || "-"}</div>
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
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                      暂无外部调用记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant="outline"
                  className={cn(
                    "border font-normal",
                    sourceBadgeClass(log.agentSource),
                  )}
                >
                  {log.agentSource}
                </Badge>
                {log.agentTool ? (
                  <span className="font-mono">{log.agentTool}</span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {log.method}
                </Badge>
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
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricTile icon={Clock} label="耗时" value={`${log.durationMs}ms`} />
                <MetricTile icon={Workflow} label="来源" value={log.agentSource} />
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
