"use client"

import type { ComponentProps, ReactNode } from "react"
import { Check, Loader2, X } from "@/components/iconimate"
import { cn } from "@/lib/utils"
import { mono, paper } from "./surfaces"

/**
 * Agent plan（来自 assistant-ui registry: elements-agent-plan）。
 *
 * 相对上游的适配，重跑 `shadcn add` 覆盖本文件时需要重新施加：
 * 1. 图标改用 @/components/iconimate（本项目唯一图标体系，未安装 lucide-react；
 *    它导出的 LucideIcon 与 lucide 结构等价）。
 * 2. 步骤的"进行中"由它自己的 status 决定，不用上游的"activeIndex 之前的都算完成"
 *    推导。上游那条规则假设计划是边跑边追加的，本项目的步骤各自带真实状态——
 *    照搬会让失败任务里所有未到步骤都被画成已完成。顺带支持 counter（右侧 "x/y"
 *    进度计数）与 details 插槽（每步下方的次要说明）。
 * 3. 新增 failed 状态：失败步骤标红。计划是"正在被重写"的，三态颜色表达不了失败。
 * 4. 去掉头部的计划进度条：本组件与 job-progress 同屏，总进度已有更精确的加权
 *    进度条，这里再画一条只会出现两个互相打架的百分比。保留标题与计数行。
 * 5. 容器改用 paper 卡片（与 job-progress / timeline 同语言），标题可配置。
 * 6. 列表 key 用下标：label 是可重复的中文短句，且行只在尾部追加。
 */

export type AgentPlanStepStatus = "done" | "active" | "pending" | "failed"

export interface AgentPlanStep {
    label: string
    status: AgentPlanStepStatus
    /** 该步右侧的进度计数，如 "2/4" */
    counter?: string
}

export function AgentPlan({
    title = "Plan",
    steps,
    details,
    className,
    ...props
}: Omit<ComponentProps<"div">, "children" | "title" | "steps" | "details"> & {
    title?: string
    steps: readonly AgentPlanStep[]
    details?: readonly ReactNode[]
}) {
    const total = steps.length
    const doneCount = steps.filter((step) => step.status === "done").length

    return (
        <div
            data-slot="agent-plan"
            className={cn(
                paper,
                "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4",
                className,
            )}

            {...props}
        >
            <div className="flex items-center justify-between">
                <span className="truncate text-[13.5px] font-medium">{title}</span>
                <span className={cn(mono, "text-foreground/35 shrink-0 tabular-nums")}>
                    {doneCount} / {total}
                </span>
            </div>
            <ul className="flex flex-col gap-2.5">
                {steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-[13.5px]">
                        <span className="mt-px flex size-4 shrink-0 items-center justify-center">
                            {step.status === "failed" ? (
                                <X aria-hidden className="size-3.5 shrink-0 text-destructive" />
                            ) : step.status === "done" ? (
                                <Check aria-hidden className="text-foreground/35 size-3.5" />
                            ) : step.status === "active" ? (
                                <Loader2
                                    aria-hidden
                                    className="text-foreground/90 size-3.5 animate-spin motion-reduce:animate-none"
                                />
                            ) : (
                                <span
                                    aria-hidden
                                    className="bg-foreground/15 size-1.5 rounded-full"
                                />
                            )}
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 leading-5",
                                        step.status === "failed" && "text-destructive",
                                        step.status === "done" && "text-foreground/40",
                                        step.status === "active" && "text-foreground/90",
                                        step.status === "pending" && "text-foreground/35",
                                    )}
                                >
                                    {step.label}
                                </span>
                                {step.counter && (
                                    <span className={cn(mono, "text-foreground/35 shrink-0 tabular-nums")}>
                                        {step.counter}
                                    </span>
                                )}
                            </div>
                            {details?.[i] != null && (
                                <div className="text-xs leading-5 break-words text-foreground/45">
                                    {details[i]}
                                </div>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    )
}
