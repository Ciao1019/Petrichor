"use client"

import { AlertCircle, Check, Loader2, Minus } from "@/components/iconimate"
import { cn } from "@/lib/utils"
import type { AgentActivityGroupViewModel } from "@/features/agent-runs/types"

/**
 * 活动列表（§162.7/§162.8/§162.22）。
 *
 * 只展示「Agent 在做什么 / 找到了什么」，不展示任何模型内部推理。
 * 展示的是聚合后的活动组，而不是逐条底层 Tool Call。
 */
export function AgentActivityList({
    groups,
    className,
}: {
    groups: AgentActivityGroupViewModel[]
    className?: string
}) {
    if (groups.length === 0) return null

    return (
        <ul className={cn("flex flex-col gap-1.5", className)} aria-label="执行步骤">
            {groups.map((group) => (
                <AgentActivityItem key={group.key} group={group} />
            ))}
        </ul>
    )
}

function AgentActivityItem({ group }: { group: AgentActivityGroupViewModel }) {
    return (
        <li className="flex items-start gap-2 text-[13px] leading-5">
            <ActivityStatusIcon status={group.status} />
            <div className="min-w-0 flex-1">
                <span className={cn(
                    "wrap-break-word",
                    group.status === "failed" ? "text-muted-foreground" : "text-foreground/90",
                )}
                >
                    {group.title}
                </span>
                {group.detail ? (
                    <span className="ml-2 text-muted-foreground">{group.detail}</span>
                ) : null}
            </div>
        </li>
    )
}

/** 状态不只靠颜色区分：同时用图标与 aria-label（§162.33） */
function ActivityStatusIcon({ status }: { status: AgentActivityGroupViewModel["status"] }) {
    const common = "mt-0.5 size-3.5 shrink-0"
    switch (status) {
        case "running":
            return <Loader2 className={cn(common, "animate-spin text-primary motion-reduce:animate-none")} aria-label="进行中" />
        case "failed":
            return <AlertCircle className={cn(common, "text-muted-foreground")} aria-label="未完成" />
        case "cancelled":
            return <Minus className={cn(common, "text-muted-foreground")} aria-label="已取消" />
        case "pending":
            return <Minus className={cn(common, "text-muted-foreground/60")} aria-label="待执行" />
        default:
            return <Check className={cn(common, "text-emerald-600 dark:text-emerald-400")} aria-label="已完成" />
    }
}
