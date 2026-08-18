import { aggregateActivities, currentActivityLabel } from "./activity-mapper"
import type { AgentRunViewModel, EvidenceViewModel } from "./types"
import { useAgentRunsStore } from "./store"

/** 选择器：组件只读派生数据，不在渲染里做聚合逻辑 */

export function useAgentRun(runId: string | null | undefined): AgentRunViewModel | null {
    return useAgentRunsStore((state) => (runId ? state.runs[runId] ?? null : null))
}

export function useActiveAgentRunId(): string | null {
    return useAgentRunsStore((state) => state.activeRunId)
}

export function selectActivityGroups(run: AgentRunViewModel) {
    return aggregateActivities(run.activities)
}

export function selectStatusLabel(run: AgentRunViewModel): string {
    switch (run.status) {
        case "starting":
            return "正在准备…"
        case "running":
            return currentActivityLabel(run.activities)
        case "completed":
            return "已完成"
        case "stopped":
            return run.stopMessage ?? "任务执行已停止"
        case "cancelled":
            return "已停止"
        case "failed":
            return run.errorMessage ?? "执行失败"
    }
}

/** 完成摘要（§162.19）：步数 + 耗时，不默认展示 token / 成本 */
export function selectCompletionSummary(run: AgentRunViewModel): string {
    const steps = run.metrics?.toolCalls ?? run.activities.length
    const duration = run.metrics?.durationMs
        ?? (run.completedAt && run.startedAt ? run.completedAt - run.startedAt : undefined)
    const parts = [`${steps} 个步骤`]
    if (duration != null) parts.push(`${(duration / 1000).toFixed(1)}s`)
    return parts.join(" · ")
}

export function selectEvidenceBySource(run: AgentRunViewModel): {
    internal: EvidenceViewModel[]
    external: EvidenceViewModel[]
} {
    const internal: EvidenceViewModel[] = []
    const external: EvidenceViewModel[] = []
    for (const item of run.evidence) {
        if (item.source === "web") external.push(item)
        else internal.push(item)
    }
    return { internal, external }
}

export function selectEvidenceByCitation(run: AgentRunViewModel, index: number): EvidenceViewModel | null {
    return run.evidence.find((item) => item.citationIndex === index) ?? null
}

export function selectRunningSubAgentCount(run: AgentRunViewModel): number {
    return run.subagents.filter((item) => item.status === "running").length
}
