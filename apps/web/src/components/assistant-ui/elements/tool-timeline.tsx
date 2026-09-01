"use client"

import { ChevronRight, type LucideIcon } from "@/components/iconimate"
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { take } from "@/components/assistant-ui/utils/range"
import { ShimmerLabel, SwapLabel } from "./surfaces"

/**
 * Tool timeline（来自 assistant-ui registry: elements-tool-timeline）。
 *
 * 相对上游的三处适配，重跑 `shadcn add` 覆盖本文件时需要重新施加：
 * 1. 图标改用 @/components/iconimate（本项目唯一图标体系，未安装 lucide-react；
 *    它导出的 LucideIcon 与 lucide 结构等价）。
 * 2. 折叠动画按 Radix Collapsible 约定写（上游的 collapsePanel 依赖 Base UI 的
 *    data-starting-style / --collapsible-panel-height，本项目 collapsible 是 Radix）。
 * 3. React key 用下标而非 step.chip：上游假设 chip 是文件路径这类天然唯一值，
 *    本项目的 chip 是可重复、也可能为空的中文摘要。列表只追加不重排，下标稳定。
 * 4. 新增 leading 插槽与标签上的 aria-live：状态不能只靠颜色和动效表达，
 *    变化也要被屏幕阅读器播报（§162.33）。
 * 5. 步骤的"进行中"由它自己的 status 决定，不用上游的"最后一个可见步骤 + streaming"。
 *    上游那条规则假设步骤列表是边跑边追加的，本项目的步骤各自带真实状态——照搬会让
 *    一个已经完成的步骤在整轮结束前一直闪。顺带支持 note（次要说明）与 duration（耗时）。
 * 另外 chip 不用等宽字体——它装的是中文短句而不是路径或命令。
 */

export interface TimelineStep {
    verb: string
    chip: string
    icon: LucideIcon
    /** 该步骤自身是否仍在进行；只有它为真才闪 */
    active?: boolean
    /** 次要说明，弱化展示 */
    note?: string
    /** 已结束步骤的耗时文案，右对齐 */
    duration?: string
}

export interface TimelineStat {
    file: string
    added?: number
    removed?: number
}

export interface ToolTimelineProps {
    steps: readonly TimelineStep[]
    visibleSteps: number
    streaming: boolean
    open: boolean
    onOpenChange: (open: boolean) => void
    restingLabel: string
    activeLabel: string
    stats: TimelineStat[]
    /** 触发行最前面的状态指示（带 aria-label），让状态不依赖颜色 */
    leading?: React.ReactNode
    className?: string
}

export function ToolTimeline({
    steps,
    visibleSteps,
    streaming,
    open,
    onOpenChange,
    restingLabel,
    activeLabel,
    stats,
    leading,
    className,
}: ToolTimelineProps) {
    return (
        <Collapsible
            data-slot="tool-timeline"
            open={open}
            onOpenChange={onOpenChange}
            className={cn("w-full", className)}
        >
            <CollapsibleTrigger className="group/trigger flex items-center gap-1.5 rounded-md py-1 text-[13.5px] text-foreground/55 outline-none transition-colors hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-ring">
                {leading}
                <ChevronRight
                    aria-hidden
                    className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none"
                />
                <span aria-live="polite" className="contents">
                    <SwapLabel active={streaming ? 0 : 1} className="text-start tabular-nums">
                        <ShimmerLabel active={streaming} className="relative inline-block leading-none">
                            {activeLabel}
                        </ShimmerLabel>
                        <>{restingLabel}</>
                    </SwapLabel>
                </span>
            </CollapsibleTrigger>
            <CollapsibleContent
                className={cn(
                    "overflow-hidden outline-none",
                    "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
                )}
            >
                <ul className="flex flex-col gap-2.5 ps-4 pt-2.5" aria-label="执行步骤">
                    {take(steps, visibleSteps).map((step, index) => {
                        const Icon = step.icon

                        return (
                            <li
                                key={index}
                                className="flex animate-in items-start gap-2 fade-in text-[13.5px] text-foreground/55 duration-300 fill-mode-both slide-in-from-bottom-1"
                            >
                                <Icon
                                    aria-hidden
                                    className={cn(
                                        "mt-0.5 size-3.5 shrink-0",
                                        step.active ? "text-foreground/60" : "text-foreground/35",
                                    )}
                                />
                                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                                    <ShimmerLabel active={step.active} className="relative inline-block leading-none">
                                        {step.verb}
                                    </ShimmerLabel>
                                    {step.chip ? (
                                        <span className="min-w-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] text-foreground/70">
                                            {step.chip}
                                        </span>
                                    ) : null}
                                    {step.note ? (
                                        <span className="min-w-0 text-[11px] text-foreground/35">{step.note}</span>
                                    ) : null}
                                </span>
                                {step.duration ? (
                                    <span className="shrink-0 text-[11px] text-foreground/35 tabular-nums">
                                        {step.duration}
                                    </span>
                                ) : null}
                            </li>
                        )
                    })}
                    {stats.length > 0 && (
                        <li className="flex flex-wrap gap-1.5 pt-1">
                            {stats.map((stat) => (
                                <span
                                    key={stat.file}
                                    className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground/70"
                                >
                                    <span>{stat.file}</span>
                                    {stat.added !== undefined && (
                                        <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>
                                    )}
                                    {stat.removed !== undefined && (
                                        <span className="text-red-600 dark:text-red-400">−{stat.removed}</span>
                                    )}
                                </span>
                            ))}
                        </li>
                    )}
                </ul>
            </CollapsibleContent>
        </Collapsible>
    )
}
