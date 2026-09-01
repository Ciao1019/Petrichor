"use client"

import { ThinkingOrb } from "thinking-orbs"

import {
    Activity,
    AlertCircle,
    AlertTriangle,
    Check,
    BookOpen,
    Brain,
    FileText,
    Globe,
    type LucideIcon,
    Minus,
    Network,
    PencilLine,
    Search,
    Sparkles,
    UserCog,
    Wrench,
} from "@/components/iconimate"
import { cn } from "@/lib/utils"
import {
    ToolTimeline,
    type TimelineStep,
} from "@/components/assistant-ui/elements/tool-timeline"
import {
    selectActivityGroups,
    selectStatusLabel,
    selectSummaryLine,
} from "@/features/agent-runs/selectors"
import type {
    AgentActivityGroupViewModel,
    AgentRunViewModel,
} from "@/features/agent-runs/types"
import type { AgentActivityType } from "@/lib/agent/tool-ui"

/**
 * Agent 执行轨迹（assistant-ui Elements 的 Tool timeline 形态）。
 *
 * 步骤来自 Run Store 的聚合活动组，而不是消息里的 tool-call part：后端在
 * tool_started / tool_completed 里已经给了人类可读的标题与安全摘要（"检索 1 次，
 * 深读了 2 个相关章节"），原始 part 只有工具名和入参，信息量差一个量级。
 * 同样地，这里不渲染任何模型内部推理。
 */

const TYPE_ICON: Record<AgentActivityType, LucideIcon> = {
    knowledge_search: Search,
    knowledge_read: BookOpen,
    graph_search: Network,
    web_search: Globe,
    web_read: Globe,
    memory_search: Brain,
    skill_load: Sparkles,
    delegation: UserCog,
    analysis: Activity,
    writing: PencilLine,
    document_operation: FileText,
    tool: Wrench,
    error: AlertCircle,
}

/** 后端给的真实工具耗时；低于 100ms 的不显示，一行数字换不来信息量 */
function formatDuration(durationMs: number | undefined): string | undefined {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 100) return undefined
    return `${(durationMs / 1000).toFixed(1)}s`
}

/** 未完成态不靠颜色区分：换图标，并把状态写进 chip 文案（§162.33） */
function toStep(group: AgentActivityGroupViewModel): TimelineStep {
    const detail = group.detail?.trim() ?? ""
    const running = group.status === "running" || group.status === "pending"
    const base = {
        verb: group.title,
        active: running,
        // 还在跑就先不给耗时：半截的数字会让人以为已经结束了
        ...(running ? {} : { duration: formatDuration(group.durationMs) }),
        ...(group.note ? { note: group.note } : {}),
    }
    switch (group.status) {
        case "failed":
            return { ...base, chip: detail ? `未完成 · ${detail}` : "未完成", icon: AlertCircle }
        case "cancelled":
            return { ...base, chip: detail ? `已取消 · ${detail}` : "已取消", icon: Minus }
        default:
            return { ...base, chip: detail, icon: TYPE_ICON[group.type] ?? Wrench }
    }
}

/**
 * "模型在想"这一拍。
 *
 * 工具跑完到下一个动作之间没有任何活动在运行，但整轮还没结束。少了这一行，
 * 触发行写着"正在分析…"，列表里却只有一个已经完成的步骤——那个 shimmer 就只能
 * 错落在它身上，看起来像检索一直没做完。开始出答案后就不再补，正文自己会说话。
 */
function thinkingStep(run: AgentRunViewModel, groups: AgentActivityGroupViewModel[]): TimelineStep | null {
    const running = run.status === "running" || run.status === "starting"
    if (!running || run.answer.trim()) return null
    if (groups.some((group) => group.status === "running" || group.status === "pending")) return null
    return { verb: "正在分析…", chip: "", icon: Activity, active: true }
}

/** 有没有可展开的轨迹；没有活动时 AgentRun 不该把计划/子任务藏在一个不存在的开关后面。 */
export function hasTimelineSteps(run: AgentRunViewModel): boolean {
    return selectActivityGroups(run).length > 0
}

/**
 * 运行状态指示：运行中用 thinking-orbs 的点阵球（connecting：星座自我连线），
 * 收尾态用静态图标。全部带 aria-label——状态不能只靠颜色和动效表达（§162.33）。
 */
function RunStatusIcon({ status }: { status: AgentRunViewModel["status"] }) {
    const common = "size-3.5 shrink-0"
    switch (status) {
        case "running":
        case "starting":
            return (
                <ThinkingOrb
                    state="connecting"
                    size={20}
                    role="img"
                    aria-label="执行中"
                    className="-my-1 shrink-0"
                />
            )
        case "completed":
            return <Check className={cn(common, "text-emerald-600 dark:text-emerald-400")} aria-label="已完成" />
        case "failed":
        case "stopped":
            return <AlertTriangle className={cn(common, "text-muted-foreground")} aria-label="已停止" />
        default:
            return <Minus className={cn(common, "text-muted-foreground")} aria-label="已取消" />
    }
}

export function AgentToolTimeline({
    run,
    open,
    onOpenChange,
}: {
    run: AgentRunViewModel
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const groups = selectActivityGroups(run)
    const thinking = thinkingStep(run, groups)
    const steps = [...groups.map(toStep), ...(thinking ? [thinking] : [])]
    const streaming = run.status === "running" || run.status === "starting"

    if (groups.length === 0) return null

    return (
        <ToolTimeline
            steps={steps}
            visibleSteps={steps.length}
            streaming={streaming}
            open={open}
            onOpenChange={onOpenChange}
            activeLabel={streaming ? selectStatusLabel(run) : ""}
            restingLabel={streaming ? "" : selectSummaryLine(run)}
            stats={[]}
            leading={<RunStatusIcon status={run.status} />}
        />
    )
}
