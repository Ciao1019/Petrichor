"use client"

import type { ComponentProps } from "react"
import { Check, Loader2, X } from "@/components/iconimate"
import { cn } from "@/lib/utils"
import { ghostButton, mono, paper } from "./surfaces"
import { announced, clamp, pct, progressOf, take } from "../utils/range"

/**
 * Job progress（来自 assistant-ui registry: elements-job-progress）。
 *
 * 相对上游的适配，重跑 `shadcn add` 覆盖本文件时需要重新施加：
 * 1. 图标改用 @/components/iconimate（本项目唯一图标体系，未安装 lucide-react；
 *    它导出的 LucideIcon 与 lucide 结构等价）。
 * 2. 新增 failed 态：进度条转红、前导图标换成红 X。上游只有"转圈或打勾"两种
 *    终态，而长任务失败时留在中间进度上，转圈会让用户误以为还在跑。
 * 3. 新增 value 插槽：标题行右侧的等宽数字位，用来展示总体百分比；eta 留给
 *    "第 x/y 次尝试"这类补充说明。上游把 eta 同时当剩余时间和终态文案用，
 *    本项目没有后端 ETA 可言。
 * 4. 取消按钮只在传入 onCancel 时渲染（本项目没有取消构建的入口）。
 * 5. 阶段标签不用等宽字体——它装的是中文阶段名，不是命令或路径；
 *    "done" 终态文案同理由此写成中文。
 * 6. 标题用 key 触发 crossfade（沿用 agent-status 的做法），消息刷新时有过渡。
 */

export interface JobStage {
    name: string
    weight: number
}

export function JobProgress({
    title,
    stages,
    stageIndex,
    stageProgress,
    value,
    eta,
    failed = false,
    onCancel,
    className,
    ...props
}: Omit<
    ComponentProps<"div">,
    | "children"
    | "title"
    | "stages"
    | "stageIndex"
    | "stageProgress"
    | "value"
    | "eta"
    | "onCancel"
> & {
    title: string
    stages: readonly JobStage[]
    stageIndex: number
    stageProgress: number
    value?: string
    eta?: string
    failed?: boolean
    onCancel?: () => void
}) {
    const stage = progressOf(stageIndex, stages.length)
    const progress = clamp(stageProgress, 0, 1)
    const totalWeight = stages.reduce((sum, item) => sum + item.weight, 0) || 1
    const completed = take(stages, stage).reduce(
        (sum, item) => sum + item.weight,
        0,
    )
    const current = stages[stage]
    const overall = pct(
        completed + (current ? current.weight * progress : 0),
        totalWeight,
    )
    const finished = stage >= stages.length

    return (
        <div
            data-slot="job-progress"
            className={cn(
                paper,
                "flex w-full max-w-sm flex-col gap-3 rounded-2xl p-4",
                className,
            )}

            {...props}
        >
            <div className="flex items-center gap-2.5">
                {finished ? (
                    <Check aria-hidden className="size-3.5 shrink-0 text-emerald-500" />
                ) : failed ? (
                    <X aria-hidden className="size-3.5 shrink-0 text-destructive" />
                ) : (
                    <Loader2
                        aria-hidden
                        className="text-foreground/35 size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                    />
                )}
                <span
                    key={title}
                    className="fade-in blur-in-[2px] animate-in min-w-0 flex-1 truncate text-[13.5px] font-medium duration-300 motion-reduce:animate-none"
                >
                    {title}
                </span>
                {value !== undefined && (
                    <span className={cn(mono, "text-foreground/60 shrink-0 tabular-nums")}>
                        {value}
                    </span>
                )}
                {eta !== undefined && (
                    <span className={cn(mono, "text-foreground/35 shrink-0 tabular-nums")}>
                        {finished && !failed ? "完成" : eta}
                    </span>
                )}
                {!finished && !failed && onCancel && (
                    <button
                        type="button"
                        aria-label="取消任务"
                        onClick={onCancel}
                        className={cn(ghostButton, "size-6 shrink-0")}
                    >
                        <X aria-hidden className="size-3.5" />
                    </button>
                )}
            </div>

            <span
                role="progressbar"
                aria-label={`${title} 进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={announced(overall)}
                className="bg-foreground/[0.06] h-1 w-full overflow-hidden rounded-full"
            >
                <span
                    className={cn(
                        "block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                        finished
                            ? "bg-emerald-500"
                            : failed
                              ? "bg-destructive"
                              : "bg-blue-500 dark:bg-blue-400",
                    )}
                    style={{ width: `${overall}%` }}
                />
            </span>

            <div className="flex flex-wrap gap-x-3 gap-y-1">
                {stages.map((item, i) => (
                    <span
                        key={item.name}
                        className={cn(
                            "text-xs leading-4",
                            i < stage
                                ? "text-foreground/35"
                                : i === stage
                                  ? failed
                                      ? "text-destructive"
                                      : "text-foreground/90"
                                  : "text-foreground/20",
                        )}
                    >
                        {item.name}
                    </span>
                ))}
            </div>
        </div>
    )
}
