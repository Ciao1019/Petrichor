"use client"

import { useState } from "react"
import { RotateCcw, Square } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { shouldShowExecutionPanel, type AgentRunViewModel } from "@/features/agent-runs/types"
import { AgentToolTimeline, hasTimelineSteps } from "./agent-tool-timeline"
import { AgentPlan } from "./agent-plan"
import { AgentSubAgents } from "./agent-subagents"

/**
 * Agent 执行轨迹（§162.1/§162.7/§162.19/§162.21）。
 *
 * 渐进披露：默认只给一行状态；展开后才看活动、计划与子任务。同一个 open 同时
 * 控制时间线和计划/子任务，折叠态就只剩一行，不再是一张描边卡片。
 * 来源统一放在回答结束后的来源条，不在这里重复展示。
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
    // 没有活动就没有展开开关；此时计划/子任务直接可见，否则会被锁在不存在的开关后面。
    const detailVisible = expanded || !hasTimelineSteps(run)

    return (
        <section
            className={cn("not-prose mb-3 flex flex-col gap-2", className)}
            aria-label="Agent 执行状态"
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <AgentToolTimeline run={run} open={expanded} onOpenChange={setExpanded} />
                </div>

                {isRunning && onStop ? (
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[12px]" onClick={onStop}>
                        <Square className="size-3" aria-hidden />
                        停止
                    </Button>
                ) : null}

                {!isRunning && run.status === "failed" && onRetry ? (
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[12px]" onClick={onRetry}>
                        <RotateCcw className="size-3" aria-hidden />
                        重试
                    </Button>
                ) : null}

                {debugHref ? (
                    <a
                        href={debugHref}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label="在 Debug 页面查看完整执行轨迹"
                    >
                        Debug
                    </a>
                ) : null}
            </div>

            {detailVisible && run.plan.length > 0 ? <AgentPlan plan={run.plan} /> : null}
            {detailVisible && run.subagents.length > 0 ? <AgentSubAgents subagents={run.subagents} /> : null}

            {run.status === "stopped" && run.stopMessage ? (
                <p className="text-[12px] text-muted-foreground">{run.stopMessage}</p>
            ) : null}

            {run.status === "failed" ? (
                <p className="text-[12px] text-muted-foreground">
                    {run.errorMessage ?? "执行过程中出现问题。"}
                </p>
            ) : null}
        </section>
    )
}
