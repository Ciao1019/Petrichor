"use client"

import { useState } from "react"
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, RotateCcw, Square } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
    selectActivityGroups,
    selectCompletionSummary,
    selectStatusLabel,
} from "@/features/agent-runs/selectors"
import { shouldShowExecutionPanel, type AgentRunViewModel } from "@/features/agent-runs/types"
import { AgentActivityList } from "./agent-activity-list"
import { AgentEvidencePanel } from "./agent-evidence"
import { AgentPlan } from "./agent-plan"
import { AgentSubAgents } from "./agent-subagents"

/**
 * Agent 执行面板（§162.1/§162.7/§162.19/§162.21）。
 *
 * 渐进披露：默认只给一行状态 + 来源入口；展开后才看计划、活动与子任务。
 * 简单请求（direct）完全不渲染本组件，保持原有简洁聊天体验。
 * 任何情况下都不展示模型隐藏推理。
 */
export function AgentRun({
    run,
    onStop,
    onRetry,
    debugHref,
    className,
}: {
    run: AgentRunViewModel | null
    onStop?: () => void
    onRetry?: () => void
    /** 传入即展示 Debug 入口；普通用户不传（§162.21 三层信息分离） */
    debugHref?: string
    className?: string
}) {
    const [expanded, setExpanded] = useState(false)

    if (!shouldShowExecutionPanel(run) || !run) return null

    const isRunning = run.status === "running" || run.status === "starting"
    const groups = selectActivityGroups(run)
    const statusLabel = selectStatusLabel(run)
    const hasDetail = groups.length > 0 || run.plan.length > 0 || run.subagents.length > 0

    return (
        <section
            className={cn("not-prose mb-3 rounded-lg border border-border/60 bg-muted/20", className)}
            aria-label="Agent 执行状态"
        >
            <header className="flex items-center gap-2 px-3 py-2">
                <button
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                    disabled={!hasDetail}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
                >
                    <RunStatusIcon status={run.status} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90" aria-live="polite">
                        {isRunning ? statusLabel : summaryLine(run)}
                    </span>
                    {hasDetail ? (
                        expanded
                            ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                            : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    ) : null}
                </button>

                {isRunning && onStop ? (
                    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[12px]" onClick={onStop}>
                        <Square className="size-3" aria-hidden />
                        停止
                    </Button>
                ) : null}

                {!isRunning && run.status === "failed" && onRetry ? (
                    <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[12px]" onClick={onRetry}>
                        <RotateCcw className="size-3" aria-hidden />
                        重试
                    </Button>
                ) : null}

                <AgentEvidencePanel evidence={run.evidence} />

                {debugHref ? (
                    <a
                        href={debugHref}
                        className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label="在 Debug 页面查看完整执行轨迹"
                    >
                        Debug
                    </a>
                ) : null}
            </header>

            {expanded && hasDetail ? (
                <div className="flex flex-col gap-3 border-t border-border/60 px-3 py-2.5">
                    <AgentPlan plan={run.plan} />
                    <AgentActivityList groups={groups} />
                    <AgentSubAgents subagents={run.subagents} />
                </div>
            ) : null}

            {run.status === "stopped" && run.stopMessage ? (
                <p className="border-t border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
                    {run.stopMessage}
                </p>
            ) : null}

            {run.status === "failed" ? (
                <p className="border-t border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
                    {run.errorMessage ?? "执行过程中出现问题。"}
                </p>
            ) : null}
        </section>
    )
}

function summaryLine(run: AgentRunViewModel): string {
    switch (run.status) {
        case "completed":
            return `已完成 · ${selectCompletionSummary(run)}`
        case "cancelled":
            return "已停止"
        case "stopped":
            return "任务已停止"
        case "failed":
            return "执行失败"
        default:
            return selectStatusLabel(run)
    }
}

function RunStatusIcon({ status }: { status: AgentRunViewModel["status"] }) {
    const common = "size-3.5 shrink-0"
    switch (status) {
        case "running":
        case "starting":
            return <Loader2 className={cn(common, "animate-spin text-primary motion-reduce:animate-none")} aria-label="执行中" />
        case "completed":
            return <Check className={cn(common, "text-emerald-600 dark:text-emerald-400")} aria-label="已完成" />
        case "failed":
        case "stopped":
            return <AlertTriangle className={cn(common, "text-muted-foreground")} aria-label="已停止" />
        default:
            return <Square className={cn(common, "text-muted-foreground")} aria-label="已取消" />
    }
}
