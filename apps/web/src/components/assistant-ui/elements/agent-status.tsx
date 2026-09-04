"use client"

import type { ComponentProps } from "react"
import { Check, RotateCcw, X } from "@/components/iconimate"
import { cn } from "@/lib/utils"
import { mono, paper } from "./surfaces"

/**
 * Agent status（来自 assistant-ui registry: elements-agent-status）。
 *
 * 相对上游的适配，重跑 `shadcn add` 覆盖本文件时需要重新施加：
 * 1. 图标改用 @/components/iconimate（本项目唯一图标体系，未安装 lucide-react；
 *    它导出的 LucideIcon 与 lucide 结构等价）。
 * 2. 新增 failed 态：红点 + 红色 X，sr-only 文案同步为 "failed"。"完成"不区分
 *    成败会让失败任务在胶囊里看起来像已经结束成功。
 * 3. 去掉 working/waiting 态的尾部装饰图标（上游画一个 Pause）：它不可交互、
 *    又暗示"可以暂停"，对只读的构建状态是误导。done/failed 的图标保留——
 *    分别暗示"可以重新来过"与"出了问题"。
 */

export type AgentState = "working" | "waiting" | "done" | "failed"

export function AgentStatus({
    state,
    label,
    elapsed,
    className,
    ...props
}: Omit<ComponentProps<"div">, "children" | "state" | "label" | "elapsed"> & {
    state: AgentState
    label: string
    elapsed?: string
}) {
    return (
        <div
            data-slot="agent-status"
            className={cn(
                paper,
                "flex w-max max-w-full items-center gap-2.5 rounded-full py-1.5 ps-3.5 pe-1.5",
                className,
            )}

            {...props}
        >
            {state === "done" ? (
                <Check aria-hidden className="size-3 shrink-0 text-emerald-500" />
            ) : state === "failed" ? (
                <span
                    aria-hidden
                    className="bg-destructive size-1.5 shrink-0 rounded-full"
                />
            ) : (
                <span
                    aria-hidden
                    className={cn(
                        "size-1.5 shrink-0 rounded-full motion-reduce:animate-none",
                        state === "working"
                            ? "animate-pulse bg-blue-500 dark:bg-blue-400"
                            : "border-foreground/35 border",
                    )}
                />
            )}
            <span className="sr-only">{state}</span>
            <span
                key={label}
                className="fade-in blur-in-[2px] animate-in min-w-0 truncate text-xs duration-300 motion-reduce:animate-none"
            >
                {label}
            </span>
            {elapsed !== undefined && state !== "done" && (
                <span className={cn(mono, "text-foreground/30 tabular-nums")}>
                    {elapsed}
                </span>
            )}
            {state === "done" || state === "failed" ? (
                <span
                    aria-hidden
                    className={cn(
                        "text-foreground/45 flex size-6 items-center justify-center rounded-full",
                        state === "failed" && "text-destructive/60",
                    )}
                >
                    {state === "done" ? <RotateCcw className="size-3" /> : <X className="size-3" />}
                </span>
            ) : null}
        </div>
    )
}
