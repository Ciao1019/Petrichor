"use client"

import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { AlertCircle, Check, ChevronDown, ChevronRight, Search } from "@/components/iconimate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { agentRunApi } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * Agent Debug 页面（§68~§71/§162.38）。
 *
 * 与普通 Chat UI 严格分离：这里读的是完整 Trace（含原始工具参数与结果），
 * 因此入口受限——需要操作员身份或显式开启 AGENT_DEBUG。
 * 页面只展示执行事实，不展示模型隐藏推理（后端也不会返回）。
 */

type TraceEvent = {
    sequence: number
    type: string
    toolId: string | null
    payload: Record<string, unknown>
    createdAt: number
}

type TraceRun = Record<string, unknown> & {
    runKey?: string
    goal?: string
    complexity?: string
    status?: string
    stopReason?: string | null
    model?: string
    toolCallCount?: number
    iterationCount?: number
    delegationCount?: number
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    durationMs?: number | null
    routingHint?: { domains: string[]; confidence: number } | null
    plan?: Array<{ id: string; goal: string; status: string }>
    metrics?: { latency?: Record<string, number> }
    evaluation?: Record<string, unknown> | null
}

export function AgentDebugPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const [runId, setRunId] = React.useState(searchParams.get("runId") ?? "")
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [run, setRun] = React.useState<TraceRun | null>(null)
    const [events, setEvents] = React.useState<TraceEvent[]>([])

    const load = React.useCallback(async (id: string) => {
        if (!id.trim()) return
        setLoading(true)
        setError(null)
        try {
            const response = await agentRunApi.trace(id.trim())
            setRun(response.data.run as TraceRun)
            setEvents(response.data.events)
            setSearchParams({ runId: id.trim() }, { replace: true })
        } catch (caught) {
            setRun(null)
            setEvents([])
            setError(readErrorMessage(caught))
        } finally {
            setLoading(false)
        }
    }, [setSearchParams])

    React.useEffect(() => {
        const initial = searchParams.get("runId")
        if (initial) void load(initial)
        // 仅首次进入时按 URL 自动加载
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6">
            <header className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold">Agent Debug</h1>
                <p className="text-sm text-muted-foreground">
                    查看单次 Agent Run 的完整执行轨迹。仅操作员或开启 AGENT_DEBUG 时可访问。
                </p>
            </header>

            <form
                className="flex gap-2"
                onSubmit={(event) => {
                    event.preventDefault()
                    void load(runId)
                }}
            >
                <Input
                    value={runId}
                    onChange={(event) => setRunId(event.target.value)}
                    placeholder="run_xxxxxxxx"
                    className="max-w-md font-mono text-sm"
                    aria-label="Run ID"
                />
                <Button type="submit" disabled={loading || !runId.trim()}>
                    <Search className="mr-1 size-4" aria-hidden />
                    {loading ? "加载中…" : "查询"}
                </Button>
            </form>

            {error ? (
                <Card>
                    <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                        <AlertCircle className="size-4" aria-hidden />
                        {error}
                    </CardContent>
                </Card>
            ) : null}

            {run ? (
                <div className="flex flex-col gap-4">
                    <RunSummaryCard run={run} />
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                        <TimelineCard events={events} />
                        <div className="flex flex-col gap-4">
                            <ToolCallsCard events={events} />
                            <EvidenceCard events={events} />
                            <RetrievalCard events={events} />
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

function RunSummaryCard({ run }: { run: TraceRun }) {
    const latency = run.metrics?.latency ?? {}
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <span className="font-mono text-sm">{String(run.runKey ?? "")}</span>
                    <Badge variant="outline">{String(run.complexity ?? "")}</Badge>
                    <Badge variant={run.status === "completed" ? "secondary" : "outline"}>
                        {String(run.status ?? "")}
                    </Badge>
                    {run.stopReason ? <Badge variant="outline">{String(run.stopReason)}</Badge> : null}
                </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
                <p className="text-muted-foreground">{String(run.goal ?? "")}</p>
                <Separator />
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
                    <Metric label="模型" value={String(run.model ?? "-")} />
                    <Metric label="迭代" value={String(run.iterationCount ?? 0)} />
                    <Metric label="工具调用" value={String(run.toolCallCount ?? 0)} />
                    <Metric label="委派" value={String(run.delegationCount ?? 0)} />
                    <Metric label="输入 token" value={String(run.inputTokens ?? 0)} />
                    <Metric label="输出 token" value={String(run.outputTokens ?? 0)} />
                    <Metric label="总耗时" value={formatMs(run.durationMs ?? latency.totalMs)} />
                    <Metric label="TTFT" value={formatMs(latency.ttftMs)} />
                    <Metric label="LLM" value={formatMs(latency.llmMs)} />
                    <Metric label="工具" value={formatMs(latency.toolMs)} />
                    <Metric label="检索" value={formatMs(latency.retrievalMs)} />
                    <Metric label="重排" value={formatMs(latency.rerankMs)} />
                </dl>
                {run.routingHint ? (
                    <p className="text-xs text-muted-foreground">
                        Router 预测：{run.routingHint.domains.join("、") || "-"}
                        （置信度 {run.routingHint.confidence.toFixed(2)}）
                    </p>
                ) : null}
            </CardContent>
        </Card>
    )
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-mono text-sm tabular-nums">{value}</dd>
        </div>
    )
}

/** §69 Timeline：按 sequence 顺序展示全部事件 */
function TimelineCard({ events }: { events: TraceEvent[] }) {
    const base = events[0]?.createdAt ?? 0
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Timeline（{events.length}）</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[70vh] overflow-y-auto p-0">
                <ol className="divide-y divide-border/60">
                    {events.map((event) => (
                        <li key={event.sequence} className="px-4 py-2">
                            <div className="flex items-baseline gap-2 text-sm">
                                <span className="w-14 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                    +{((event.createdAt - base) / 1000).toFixed(2)}s
                                </span>
                                <span className="font-mono text-xs text-muted-foreground">#{event.sequence}</span>
                                <span className="font-medium">{event.type}</span>
                                {event.toolId ? (
                                    <span className="font-mono text-xs text-muted-foreground">{event.toolId}</span>
                                ) : null}
                            </div>
                            <PayloadDisclosure payload={event.payload} />
                        </li>
                    ))}
                </ol>
            </CardContent>
        </Card>
    )
}

/** §70 Tool Call 明细：参数、耗时、结果摘要、原始结果、错误、重试、产出证据 */
function ToolCallsCard({ events }: { events: TraceEvent[] }) {
    const calls = events.filter((event) => event.type === "tool_result" || (event.type === "error" && event.toolId))
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Tool Calls（{calls.length}）</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[40vh] overflow-y-auto p-0">
                <ul className="divide-y divide-border/60">
                    {calls.map((event) => {
                        const payload = event.payload as {
                            toolId?: string
                            namespace?: string
                            ok?: boolean
                            durationMs?: number
                            retries?: number
                            errorCode?: string
                            summary?: string
                            evidenceIds?: string[]
                            permissionDecision?: string
                        }
                        return (
                            <li key={event.sequence} className="px-4 py-2 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    {payload.ok
                                        ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="成功" />
                                        : <AlertCircle className="size-3.5 text-muted-foreground" aria-label="失败" />}
                                    <span className="font-mono text-xs">{payload.toolId}</span>
                                    <Badge variant="outline" className="text-[10px]">{payload.namespace}</Badge>
                                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                        {payload.durationMs ?? 0}ms
                                    </span>
                                    {payload.retries ? (
                                        <Badge variant="outline" className="text-[10px]">retry×{payload.retries}</Badge>
                                    ) : null}
                                    {payload.errorCode ? (
                                        <Badge variant="outline" className="text-[10px]">{payload.errorCode}</Badge>
                                    ) : null}
                                    {payload.permissionDecision === "denied" ? (
                                        <Badge variant="outline" className="text-[10px]">permission_denied</Badge>
                                    ) : null}
                                    {payload.evidenceIds?.length ? (
                                        <Badge variant="outline" className="text-[10px]">
                                            evidence×{payload.evidenceIds.length}
                                        </Badge>
                                    ) : null}
                                </div>
                                {payload.summary ? (
                                    <p className="mt-1 text-xs text-muted-foreground">{payload.summary}</p>
                                ) : null}
                                <PayloadDisclosure payload={event.payload} label="原始参数与结果" />
                            </li>
                        )
                    })}
                </ul>
            </CardContent>
        </Card>
    )
}

/** §71 Evidence 明细 */
function EvidenceCard({ events }: { events: TraceEvent[] }) {
    const evidence = events
        .filter((event) => event.type === "tool_result")
        .flatMap((event) => {
            const ids = (event.payload as { evidenceIds?: string[] }).evidenceIds ?? []
            return ids.map((id) => ({ id, toolId: String((event.payload as { toolId?: string }).toolId ?? "") }))
        })

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Evidence（{evidence.length}）</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[30vh] overflow-y-auto">
                {evidence.length === 0 ? (
                    <p className="text-sm text-muted-foreground">本次 Run 没有产生证据。</p>
                ) : (
                    <ul className="flex flex-col gap-1 text-xs">
                        {evidence.map((item) => (
                            <li key={item.id} className="flex items-center gap-2">
                                <span className="font-mono">{item.id}</span>
                                <span className="text-muted-foreground">← {item.toolId}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    )
}

/** §94 检索诊断 */
function RetrievalCard({ events }: { events: TraceEvent[] }) {
    const diagnostics = events.filter((event) => event.type === "retrieval_diagnostics")
    if (diagnostics.length === 0) return null

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">检索诊断（{diagnostics.length}）</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[30vh] overflow-y-auto">
                <ul className="flex flex-col gap-2">
                    {diagnostics.map((event) => (
                        <li key={event.sequence}>
                            <PayloadDisclosure payload={event.payload} label="召回明细" defaultOpen />
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    )
}

function PayloadDisclosure({
    payload,
    label = "payload",
    defaultOpen = false,
}: {
    payload: Record<string, unknown>
    label?: string
    defaultOpen?: boolean
}) {
    const [open, setOpen] = React.useState(defaultOpen)
    if (!payload || Object.keys(payload).length === 0) return null

    return (
        <div className="mt-1">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
                {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
                {label}
            </button>
            {open ? (
                <pre className={cn(
                    "mt-1 max-h-64 overflow-auto rounded border border-border/60 bg-muted/40 p-2",
                    "font-mono text-[11px] leading-4 wrap-break-word whitespace-pre-wrap",
                )}
                >
                    {JSON.stringify(payload, null, 2)}
                </pre>
            ) : null}
        </div>
    )
}

function formatMs(value: number | null | undefined): string {
    if (value == null) return "-"
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

function readErrorMessage(error: unknown): string {
    const message = (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg
    if (message === "agent_debug_disabled") return "当前账号无权访问调试信息（需要操作员身份或开启 AGENT_DEBUG）。"
    if (message) return message
    return "加载失败，请确认 Run ID 是否正确。"
}

export default AgentDebugPage
