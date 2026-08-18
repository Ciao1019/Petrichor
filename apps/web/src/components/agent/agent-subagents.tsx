"use client"

import { AlertCircle, Check, Loader2, Minus } from "@/components/iconimate"
import { cn } from "@/lib/utils"
import type { SubAgentViewModel } from "@/features/agent-runs/types"

/**
 * 子代理区域（§162.11/§162.12）。
 *
 * 多个子代理并行时各自独立更新状态，不能看起来像串行执行。
 * 移动端纵向排列（§162.31）。
 */
export function AgentSubAgents({
    subagents,
    className,
}: {
    subagents: SubAgentViewModel[]
    className?: string
}) {
    if (subagents.length === 0) return null

    const running = subagents.filter((item) => item.status === "running").length
    const heading = running > 0
        ? `正在并行研究 ${subagents.length} 个主题`
        : `已完成 ${subagents.length} 个子任务`

    return (
        <section className={cn("flex flex-col gap-2", className)} aria-label="子任务">
            <p className="text-[12px] font-medium text-muted-foreground" aria-live="polite">{heading}</p>
            <ul className="flex flex-col gap-1.5">
                {subagents.map((item) => (
                    <AgentSubAgentCard key={item.id} subagent={item} />
                ))}
            </ul>
        </section>
    )
}

function AgentSubAgentCard({ subagent }: { subagent: SubAgentViewModel }) {
    return (
        <li className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
            <SubAgentStatusIcon status={subagent.status} />
            <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-5 text-foreground/90">{subagent.objective}</p>
                {subagent.status === "running" ? (
                    <p className="text-[12px] text-muted-foreground">正在检索资料…</p>
                ) : subagent.summary ? (
                    <p className="line-clamp-2 text-[12px] text-muted-foreground">{subagent.summary}</p>
                ) : null}
                {subagent.evidenceCount ? (
                    <p className="mt-0.5 text-[12px] text-muted-foreground">{subagent.evidenceCount} 个来源</p>
                ) : null}
            </div>
        </li>
    )
}

function SubAgentStatusIcon({ status }: { status: SubAgentViewModel["status"] }) {
    const common = "mt-0.5 size-3.5 shrink-0"
    switch (status) {
        case "running":
            return <Loader2 className={cn(common, "animate-spin text-primary motion-reduce:animate-none")} aria-label="进行中" />
        case "completed":
            return <Check className={cn(common, "text-emerald-600 dark:text-emerald-400")} aria-label="已完成" />
        case "failed":
            return <AlertCircle className={cn(common, "text-muted-foreground")} aria-label="未完成" />
        case "cancelled":
            return <Minus className={cn(common, "text-muted-foreground")} aria-label="已取消" />
        default:
            return <Minus className={cn(common, "text-muted-foreground/60")} aria-label="待执行" />
    }
}
