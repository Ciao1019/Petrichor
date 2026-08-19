import {
    resolveToolUiSpec,
    toolActivityGroup,
    toolActivityType,
    type AgentActivityType,
} from "@/lib/agent/tool-ui"
import type {
    AgentActivityGroupViewModel,
    AgentActivityViewModel,
    AgentStreamEvent,
} from "./types"

/**
 * Tool → Activity 映射与聚合（§162.8/§162.9）。
 *
 * 组件里不写 toolId 的 if/else：语义映射集中在 @/lib/agent/tool-ui，
 * 这里只负责把事件转成 ViewModel，并把同类活动聚合成一条可读条目。
 */

export function activityFromToolStarted(event: AgentStreamEvent): AgentActivityViewModel {
    const payload = event.payload as { callId: string; toolId: string; title: string }
    return {
        id: payload.callId,
        type: toolActivityType(payload.toolId),
        title: payload.title,
        status: "running",
        startedAt: event.timestamp,
        group: toolActivityGroup(payload.toolId),
        metadata: { toolId: payload.toolId },
    }
}

export function activityPatchFromToolCompleted(event: AgentStreamEvent): Partial<AgentActivityViewModel> & { id: string } {
    const payload = event.payload as {
        callId: string
        toolId: string
        summary: string
        durationMs: number
        evidenceIds: string[]
    }
    return {
        id: payload.callId,
        title: resolveToolUiSpec(payload.toolId).done,
        description: payload.summary,
        status: "completed",
        completedAt: event.timestamp,
        metadata: { toolId: payload.toolId, evidenceCount: payload.evidenceIds?.length ?? 0 },
    }
}

export function activityPatchFromToolFailed(event: AgentStreamEvent): Partial<AgentActivityViewModel> & { id: string } {
    const payload = event.payload as { callId: string; toolId: string; message: string; willRetry: boolean }
    return {
        id: payload.callId,
        // 失败中的重试对用户表述为"正在尝试其它来源"，而不是红色报错刷屏（§162.45）
        title: payload.willRetry ? "正在尝试其它来源" : resolveToolUiSpec(payload.toolId).done,
        description: payload.message,
        status: payload.willRetry ? "running" : "failed",
        ...(payload.willRetry ? {} : { completedAt: event.timestamp }),
        metadata: { toolId: payload.toolId },
    }
}

export function activityFromSkillLoaded(event: AgentStreamEvent): AgentActivityViewModel {
    const payload = event.payload as { skillId: string; name: string }
    return {
        id: `skill:${payload.skillId}`,
        type: "skill_load",
        title: `启用${payload.name}能力`,
        status: "completed",
        startedAt: event.timestamp,
        completedAt: event.timestamp,
        group: "skill",
        metadata: { skillId: payload.skillId },
    }
}

export function activityFromDelegation(event: AgentStreamEvent): AgentActivityViewModel {
    const payload = event.payload as { taskId: string; objective: string }
    return {
        id: `task:${payload.taskId}`,
        type: "delegation",
        title: "委派子任务",
        description: payload.objective,
        status: "running",
        startedAt: event.timestamp,
        group: "delegation",
        metadata: { taskId: payload.taskId },
    }
}

/**
 * 活动聚合：把同组的多次底层调用合并成一条。
 * 例如 knowledge.search + knowledge.read ×4 → 「检索并阅读知识库 · 检索 1 次，深读了 4 个相关章节」。
 */
export function aggregateActivities(activities: AgentActivityViewModel[]): AgentActivityGroupViewModel[] {
    const groups = new Map<string, AgentActivityGroupViewModel>()
    const members = new Map<string, AgentActivityViewModel[]>()

    for (const activity of activities) {
        members.set(activity.group, [...(members.get(activity.group) ?? []), activity])
        const existing = groups.get(activity.group)
        if (!existing) {
            groups.set(activity.group, {
                key: activity.group,
                type: activity.type,
                title: groupTitle(activity.group, activity.type, activity.title),
                status: activity.status,
                count: 1,
                ...(activity.startedAt != null ? { startedAt: activity.startedAt } : {}),
                ...(activity.completedAt != null ? { completedAt: activity.completedAt } : {}),
            })
            continue
        }

        existing.count += 1
        // 组状态取"最不确定"的那个：只要还有在跑的就算运行中
        existing.status = mergeStatus(existing.status, activity.status)
        if (activity.completedAt != null) {
            existing.completedAt = Math.max(existing.completedAt ?? 0, activity.completedAt)
        }
        if (activity.status === "running") existing.completedAt = undefined
    }

    for (const group of groups.values()) {
        group.detail = groupDetail(group, members.get(group.key) ?? [])
    }

    return [...groups.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}

const GROUP_TITLE: Record<string, string> = {
    knowledge: "检索并阅读知识库",
    graph: "查询知识图谱",
    research: "查询外部资料",
    memory: "检索长期记忆",
    document: "检索并阅读文档",
    writer: "整理并生成内容",
    system: "分析站点信息",
    skill: "启用所需能力",
    delegation: "并行研究子主题",
}

function groupTitle(group: string, _type: AgentActivityType, fallback: string): string {
    return GROUP_TITLE[group] ?? fallback
}

function groupDetail(
    group: AgentActivityGroupViewModel,
    activities: AgentActivityViewModel[],
): string | undefined {
    switch (group.key) {
        case "knowledge": {
            const searchCount = countTool(activities, "knowledge.search") + countTool(activities, "knowledge.lookup")
            const searches = activities.filter((item) =>
                item.metadata?.toolId === "knowledge.search" || item.metadata?.toolId === "knowledge.lookup")
            const reads = activities.filter((item) =>
                item.metadata?.toolId === "knowledge.lookup"
                || item.metadata?.toolId === "knowledge.read"
                || item.metadata?.toolId === "knowledge.read_many")
            const readableCount = reads.reduce((count, item) =>
                count + (hasEvidence(item) ? Number(item.metadata?.evidenceCount ?? 0) : 0), 0)
            const runningCount = reads.filter((item) => item.status === "running").length
            const retrieval = latestRetrievalLabel(searches)
            if (readableCount > 0) {
                const searchDetail = searchCount > 0 ? `检索 ${searchCount} 次，` : ""
                const runningDetail = runningCount > 0 ? "，仍在继续阅读" : ""
                const retrievalDetail = retrieval ? ` · ${retrieval}` : ""
                return `${searchDetail}深读了 ${readableCount} 个相关章节${runningDetail}${retrievalDetail}`
            }
            if (runningCount > 0) return `正在深读 ${runningCount} 个候选章节`
            if (reads.length > 0) return `尝试读取了 ${reads.length} 个章节，但没有可引用正文`
            if (searchCount > 0 && retrieval) return `${searchCount > 1 ? `完成了 ${searchCount} 次检索 · ` : ""}${retrieval}`
            return searchCount > 1 ? `完成了 ${searchCount} 次检索` : undefined
        }
        case "research": {
            const sourceCount = activities
                .filter((item) => item.metadata?.toolId === "research.fetch"
                    || item.metadata?.toolId === "research.extract")
                .filter(hasEvidence)
                .length
            return sourceCount > 0 ? `获取了 ${sourceCount} 个来源` : undefined
        }
        case "document": {
            const fragmentCount = activities.filter(hasEvidence).length
            return fragmentCount > 0 ? `查看了 ${fragmentCount} 个文档片段` : undefined
        }
        case "delegation":
            return `${group.count} 个子任务`
        default:
            return group.count > 1 ? `共 ${group.count} 步` : undefined
    }
}

function countTool(activities: AgentActivityViewModel[], toolId: string): number {
    return activities.filter((item) => item.metadata?.toolId === toolId).length
}

function hasEvidence(activity: AgentActivityViewModel): boolean {
    return activity.status === "completed"
        && typeof activity.metadata?.evidenceCount === "number"
        && activity.metadata.evidenceCount > 0
}

/** 从后端安全摘要中提取用户可读的召回方式，不向普通 UI 暴露原始 Trace/分数。 */
function latestRetrievalLabel(searches: AgentActivityViewModel[]): string | undefined {
    for (let index = searches.length - 1; index >= 0; index -= 1) {
        const summary = searches[index].description ?? ""
        const start = summary.indexOf("（")
        const end = summary.lastIndexOf("）")
        if (start >= 0 && end > start) return summary.slice(start + 1, end)
    }
    return undefined
}

const STATUS_RANK: Record<AgentActivityViewModel["status"], number> = {
    running: 4,
    pending: 3,
    failed: 2,
    cancelled: 1,
    completed: 0,
}

function mergeStatus(
    left: AgentActivityViewModel["status"],
    right: AgentActivityViewModel["status"],
): AgentActivityViewModel["status"] {
    return STATUS_RANK[right] > STATUS_RANK[left] ? right : left
}

/** 运行中状态条文案：取最近一条仍在进行的活动（§162.20） */
export function currentActivityLabel(activities: AgentActivityViewModel[]): string {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
        const activity = activities[index]
        if (activity.status === "running") return `${activity.title}…`
    }
    return activities.length > 0 ? "正在分析…" : "正在准备…"
}
