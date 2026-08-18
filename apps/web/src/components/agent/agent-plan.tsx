"use client"

import { Check, Circle, CircleDot, Minus, X } from "@/components/iconimate"
import { cn } from "@/lib/utils"
import type { AgentPlanViewModel } from "@/features/agent-runs/types"

/**
 * 计划视图（§162.10）。
 *
 * Agent 中途改计划时随事件实时更新；direct/simple 请求不会有计划，
 * 因此这里只在 plan 非空时渲染。
 */
export function AgentPlan({ plan, className }: { plan: AgentPlanViewModel[]; className?: string }) {
    if (plan.length === 0) return null

    return (
        <ol className={cn("flex flex-col gap-1.5", className)} aria-label="任务计划">
            {plan.map((step) => (
                <AgentPlanStep key={step.id} step={step} />
            ))}
        </ol>
    )
}

function AgentPlanStep({ step }: { step: AgentPlanViewModel }) {
    return (
        <li className="flex items-start gap-2 text-[13px] leading-5">
            <PlanStatusIcon status={step.status} />
            <div className="min-w-0 flex-1">
                <span className={cn(
                    "wrap-break-word",
                    step.status === "completed" && "text-muted-foreground",
                    step.status === "skipped" && "text-muted-foreground line-through",
                    step.status === "running" && "font-medium text-foreground",
                )}
                >
                    {step.goal}
                </span>
                {step.resultSummary ? (
                    <p className="mt-0.5 text-[12px] text-muted-foreground">{step.resultSummary}</p>
                ) : null}
            </div>
        </li>
    )
}

function PlanStatusIcon({ status }: { status: AgentPlanViewModel["status"] }) {
    const common = "mt-0.5 size-3.5 shrink-0"
    switch (status) {
        case "completed":
            return <Check className={cn(common, "text-emerald-600 dark:text-emerald-400")} aria-label="已完成" />
        case "running":
            return <CircleDot className={cn(common, "animate-pulse text-primary motion-reduce:animate-none")} aria-label="进行中" />
        case "failed":
            return <X className={cn(common, "text-muted-foreground")} aria-label="未完成" />
        case "skipped":
            return <Minus className={cn(common, "text-muted-foreground/70")} aria-label="已跳过" />
        default:
            return <Circle className={cn(common, "text-muted-foreground/50")} aria-label="待执行" />
    }
}
