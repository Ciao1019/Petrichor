import { aggregateActivities, currentActivityLabel } from "./activity-mapper"
import type { AgentRunViewModel, EvidenceViewModel } from "./types"
import { useAgentRunsStore } from "./store"
import { groupEvidenceBySource } from "./evidence-sources"

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
    // 步数要和展开后能数到的行数一致。metrics.toolCalls 是后端的原始调用次数，
    // 而时间线展示的是聚合后的活动组（3 次 knowledge.* 合成一行），直接用它会出现
    // "已完成 · 8 个步骤" 点开却只有 3 行的矛盾。
    const steps = selectActivityGroups(run).length || run.metrics?.toolCalls || run.activities.length
    const duration = run.metrics?.durationMs
        ?? (run.completedAt && run.startedAt ? run.completedAt - run.startedAt : undefined)
    const parts = [`${steps} 个步骤`]
    if (duration != null) parts.push(`${(duration / 1000).toFixed(1)}s`)
    return parts.join(" · ")
}

/** 收尾态的一行静态摘要；运行中交给 selectStatusLabel 输出当前活动 */
export function selectSummaryLine(run: AgentRunViewModel): string {
    switch (run.status) {
        case "completed":
            return `已完成 · ${selectCompletionSummary(run)}`
        case "cancelled":
            return "已停止"
        case "stopped":
            return "任务已停止"
        case "failed":
            return "执行失败"
        default:
            return selectStatusLabel(run)
    }
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

/** 来源条按真实文档归并；同一文章命中的多个章节只展示一个编号。 */
export function selectCitedEvidenceSources(run: AgentRunViewModel): EvidenceViewModel[] {
    const used = new Set(
        (run.answer.match(/\[(\d{1,2})\]/g) ?? []).map((token) => Number(token.slice(1, -1))),
    )
    const groups = groupEvidenceBySource(run.evidence)
    if (used.size === 0) {
        return groups.flatMap((group) => group.evidence[0] ? [group.evidence[0]] : [])
    }

    return groups.flatMap((group) => {
        const cited = group.evidence.find((item) => used.has(item.citationIndex))
        return cited ? [cited] : []
    })
}

/** 来源条只在回答进入终态后出现，运行中不提前泄露或重复占位。 */
export function shouldShowCitationSources(run: AgentRunViewModel | null): boolean {
    if (!run || run.status === "starting" || run.status === "running") return false
    return selectCitedEvidenceSources(run).length > 0
}

export function selectRunningSubAgentCount(run: AgentRunViewModel): number {
    return run.subagents.filter((item) => item.status === "running").length
}
