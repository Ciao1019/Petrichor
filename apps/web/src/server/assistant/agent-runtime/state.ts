import { newId, newRunId } from "./ids"
import type {
    AgentEvidence,
    AgentObservation,
    AgentPlanStep,
    AgentPlanStepStatus,
    AgentState,
    AgentStopReason,
    AgentTokenUsage,
    TaskComplexity,
} from "./types"

/**
 * Agent 状态容器（§6）。
 *
 * 设计约束：
 * - 完全可序列化（snapshot / restore），不依赖 LLM chat history 就能恢复；
 * - 每次 Tool Call、Skill Load、Delegation 之后都必须更新；
 * - 为后续 Resume / 长任务预留持久化能力，但当前版本不做后台异步执行。
 */
export class AgentStateStore {
    private state: AgentState

    constructor(init: {
        runId?: string
        conversationId: string
        userId: string
        goal: string
        complexity?: TaskComplexity
        now?: number
    }) {
        const now = init.now ?? Date.now()
        this.state = {
            runId: init.runId ?? newRunId(),
            conversationId: init.conversationId,
            userId: init.userId,
            goal: init.goal,
            complexity: init.complexity ?? "simple",
            plan: [],
            completedSteps: [],
            pendingSteps: [],
            loadedSkills: [],
            observations: [],
            evidence: [],
            openQuestions: [],
            assumptions: [],
            toolCallCount: 0,
            delegationCount: 0,
            iteration: 0,
            tokenUsage: { input: 0, output: 0, total: 0 },
            startedAt: now,
            updatedAt: now,
            status: "running",
        }
    }

    /** 从快照恢复（为 Resume 预留） */
    static restore(snapshot: AgentState): AgentStateStore {
        const store = new AgentStateStore({
            runId: snapshot.runId,
            conversationId: snapshot.conversationId,
            userId: snapshot.userId,
            goal: snapshot.goal,
            complexity: snapshot.complexity,
            now: snapshot.startedAt,
        })
        store.state = structuredClone(snapshot)
        return store
    }

    /** 只读引用，供 ToolExecutionContext 传递；外部禁止直接改字段 */
    get current(): AgentState {
        return this.state
    }

    snapshot(): AgentState {
        return structuredClone(this.state)
    }

    private touch(): void {
        this.state.updatedAt = Date.now()
    }

    // ---------------------------------------------------------------- 复杂度
    setComplexity(complexity: TaskComplexity): void {
        this.state.complexity = complexity
        this.touch()
    }

    // -------------------------------------------------------------------- Plan
    /** 生成计划；简单请求不应调用（§7） */
    setPlan(steps: Array<{ id?: string; goal: string; dependsOn?: string[] }>): AgentPlanStep[] {
        this.state.plan = steps.map((step) => ({
            id: step.id ?? newId("step"),
            goal: step.goal,
            status: "pending" as AgentPlanStepStatus,
            ...(step.dependsOn?.length ? { dependsOn: step.dependsOn } : {}),
        }))
        this.syncPlanBuckets()
        this.touch()
        return this.state.plan
    }

    addPlanStep(step: { goal: string; dependsOn?: string[]; afterId?: string }): AgentPlanStep {
        const next: AgentPlanStep = {
            id: newId("step"),
            goal: step.goal,
            status: "pending",
            ...(step.dependsOn?.length ? { dependsOn: step.dependsOn } : {}),
        }
        const index = step.afterId ? this.state.plan.findIndex((item) => item.id === step.afterId) : -1
        if (index >= 0) this.state.plan.splice(index + 1, 0, next)
        else this.state.plan.push(next)
        this.syncPlanBuckets()
        this.touch()
        return next
    }

    updatePlanStep(
        id: string,
        patch: { goal?: string; status?: AgentPlanStepStatus; resultSummary?: string },
    ): AgentPlanStep | null {
        const step = this.state.plan.find((item) => item.id === id)
        if (!step) return null
        if (patch.goal != null) step.goal = patch.goal
        if (patch.status != null) step.status = patch.status
        if (patch.resultSummary != null) step.resultSummary = patch.resultSummary
        this.syncPlanBuckets()
        this.touch()
        return step
    }

    removePlanStep(id: string): boolean {
        const before = this.state.plan.length
        this.state.plan = this.state.plan.filter((item) => item.id !== id)
        const removed = this.state.plan.length !== before
        if (removed) {
            this.syncPlanBuckets()
            this.touch()
        }
        return removed
    }

    /** 重新排序：给定完整 id 顺序，未列出的保持原相对次序追加在后 */
    reorderPlan(orderedIds: string[]): AgentPlanStep[] {
        const byId = new Map(this.state.plan.map((step) => [step.id, step]))
        const next: AgentPlanStep[] = []
        for (const id of orderedIds) {
            const step = byId.get(id)
            if (step) {
                next.push(step)
                byId.delete(id)
            }
        }
        for (const step of this.state.plan) {
            if (byId.has(step.id)) next.push(step)
        }
        this.state.plan = next
        this.syncPlanBuckets()
        this.touch()
        return next
    }

    private syncPlanBuckets(): void {
        this.state.completedSteps = this.state.plan.filter(
            (step) => step.status === "completed" || step.status === "skipped",
        )
        this.state.pendingSteps = this.state.plan.filter(
            (step) => step.status === "pending" || step.status === "running",
        )
    }

    // ------------------------------------------------------------------ Skill
    markSkillLoaded(skillId: string): boolean {
        if (this.state.loadedSkills.includes(skillId)) return false
        this.state.loadedSkills.push(skillId)
        this.touch()
        return true
    }

    hasSkill(skillId: string): boolean {
        return this.state.loadedSkills.includes(skillId)
    }

    // ------------------------------------------------------- Observation/证据
    addObservation(observation: AgentObservation): AgentObservation {
        this.state.observations.push(observation)
        this.touch()
        return observation
    }

    addEvidence(evidence: AgentEvidence[]): void {
        if (evidence.length === 0) return
        // EvidenceStore 去重后可能返回已存在的条目，这里按 id 再挡一次，避免 State 里出现重复
        const known = new Set(this.state.evidence.map((item) => item.id))
        const next = evidence.filter((item) => !known.has(item.id))
        if (next.length === 0) return
        this.state.evidence.push(...next)
        this.touch()
    }

    // ------------------------------------------------------------------ 计数
    incrementToolCall(): number {
        this.state.toolCallCount += 1
        this.touch()
        return this.state.toolCallCount
    }

    incrementDelegation(): number {
        this.state.delegationCount += 1
        this.touch()
        return this.state.delegationCount
    }

    incrementIteration(): number {
        this.state.iteration += 1
        this.touch()
        return this.state.iteration
    }

    addTokenUsage(usage: Partial<AgentTokenUsage>): void {
        const input = usage.input ?? 0
        const output = usage.output ?? 0
        this.state.tokenUsage.input += input
        this.state.tokenUsage.output += output
        this.state.tokenUsage.total += usage.total ?? input + output
        this.touch()
    }

    // ---------------------------------------------------------- 未决问题/假设
    addOpenQuestion(question: string): void {
        if (!question.trim() || this.state.openQuestions.includes(question)) return
        this.state.openQuestions.push(question)
        this.touch()
    }

    addAssumption(assumption: string): void {
        if (!assumption.trim() || this.state.assumptions.includes(assumption)) return
        this.state.assumptions.push(assumption)
        this.touch()
    }

    // ------------------------------------------------------------------ 终态
    finish(status: Exclude<AgentState["status"], "running">, reason?: AgentStopReason): void {
        this.state.status = status
        if (reason) this.state.stopReason = reason
        this.touch()
    }
}
