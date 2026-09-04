"use client"

import {
    AlertCircle,
    Brain,
    FileText,
    ListTodo,
    Network,
    RefreshCw,
    Search,
    Wrench,
    type LucideIcon,
} from "@/components/iconimate"
import {
    ToolTimeline,
    type TimelineStep,
} from "@/components/assistant-ui/elements/tool-timeline"
import type { ArticleKnowledgeBuildAgentActivity } from "@/lib/api"
import * as React from "react"

/**
 * 知识构建的 ADK 执行动态（assistant-ui Elements 的 Tool timeline 形态）。
 *
 * 与 Agent 运行页共用 ToolTimeline，但映射更简单：后端已经把"工具动作与校验
 * 状态"整理成人类可读的 title/detail，这里只做字段对位。正文、提示词、工具
 * 结果和模型思维链不会出现在这里（展开区底部的说明向用户交代这一点）。
 */

const ACTIVITY_KIND_LABELS: Record<string, string> = {
    lifecycle: "Agent",
    tool: "工具",
    plan: "计划",
    delegation: "委派",
    context: "上下文",
    retry: "重试",
    validation: "校验",
}

function ActivityKindIcon({ kind }: { kind: string }): LucideIcon {
    if (kind === "plan") return ListTodo
    if (kind === "delegation") return Network
    if (kind === "context") return Brain
    if (kind === "retry") return RefreshCw
    if (kind === "validation") return Search
    if (kind === "tool") return Wrench
    return FileText
}

function formatActivityTime(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "--:--:--"
    return new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(date)
}

/**
 * 未完成态不靠颜色区分：换图标，并把状态写进 chip 文案（§162.33）。
 * agentName / round / toolName 各自是独立文本节点，读屏与测试都按段定位。
 */
function toStep(activity: ArticleKnowledgeBuildAgentActivity): TimelineStep {
    const detail = activity.detail?.trim() ?? ""
    const running = activity.status === "running"
    const failed = activity.status === "failed"
    const KindIcon = ActivityKindIcon({ kind: activity.kind })
    const base = {
        verb: activity.title,
        active: running,
        time: formatActivityTime(activity.updatedAt || activity.createdAt),
        note: (
            <>
                <span className="inline-flex items-center gap-1">
                    <KindIcon aria-hidden className="size-3" />
                    {ACTIVITY_KIND_LABELS[activity.kind] ?? "动作"}
                </span>
                {activity.agentName ? <> · <span>{activity.agentName}</span></> : null}
                {activity.round ? <> · <span>第 {activity.round} 轮</span></> : null}
                {activity.toolName ? <> · <span className="font-mono">{activity.toolName}</span></> : null}
            </>
        ),
    }
    if (failed) {
        return { ...base, chip: detail ? `未完成 · ${detail}` : "未完成", icon: AlertCircle }
    }
    return { ...base, chip: detail, icon: KindIcon }
}

export function KnowledgeBuildAgentActivity({
    activities,
}: {
    activities: ArticleKnowledgeBuildAgentActivity[]
}) {
    const ordered = React.useMemo(() => (
        [...activities].sort((left, right) => (
            Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)
        ))
    ), [activities])
    const [open, setOpen] = React.useState(true)
    const current = ordered.find((activity) => activity.status === "running")
    const streaming = current != null

    if (activities.length === 0) return null

    return (
        <section aria-label="ADK 执行动态">
            <ToolTimeline
                steps={ordered.map(toStep)}
                visibleSteps={ordered.length}
                streaming={streaming}
                open={open}
                onOpenChange={setOpen}
                activeLabel={streaming ? "实时" : ""}
                restingLabel={streaming ? "" : `${activities.length} 条`}
                stats={[]}
                listClassName="max-h-80 overflow-y-auto"
                footer={(
                    <p className="pt-2.5 ps-4 text-[11px] leading-4 text-foreground/35">
                        展示实际工具动作与校验状态；正文、提示词、工具结果和模型思维链不会出现在这里。
                    </p>
                )}
                leading={(
                    <span className="flex items-center gap-1.5">
                        <Brain aria-hidden className="size-3.5 shrink-0 text-primary" />
                        ADK 执行动态
                    </span>
                )}
            />
            <p className="sr-only" aria-live="polite">
                {current ? `当前：${current.title}` : "ADK 执行动态已更新"}
            </p>
        </section>
    )
}
