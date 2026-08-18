import { SUBAGENT_DEFAULT_TIMEOUT_MS, SUBAGENT_MAX_PARALLEL } from "./config"
import type { BudgetTracker } from "./budget"
import type { EvidenceStore } from "./evidence"
import type { AgentEventEmitter } from "./events"
import type { AgentStateStore } from "./state"
import type { StopPolicy } from "./stop-policy"
import type { SubAgentRuntime } from "./subagent-runtime"
import type {
    AgentEvidence,
    DelegateTaskInput,
    DelegationResult,
    ToolExecutionContext,
} from "./types"

/**
 * 委派编排（§50/§51/§53）。
 *
 * 负责：深度限制、子代理配额、并行度控制、超时、部分成功、取消与 Trace。
 * 单次搜索、单次读节点、简单问答不应该走这里。
 */
export type DelegationManagerDeps = {
    subAgents: SubAgentRuntime
    state: AgentStateStore
    evidence: EvidenceStore
    stopPolicy: StopPolicy
    budget: BudgetTracker
    events?: AgentEventEmitter
    /** 主 Agent 当前实际可用的工具（子代理只能取子集） */
    getParentToolIds: () => string[]
    /** 挑选要带给子代理的证据 */
    selectContextEvidence?: (objective: string) => AgentEvidence[]
}

export class DelegationManager {
    constructor(private readonly deps: DelegationManagerDeps) {}

    async delegate(input: DelegateTaskInput, ctx: ToolExecutionContext): Promise<DelegationResult> {
        const results = await this.delegateMany([input], ctx)
        return results[0]
    }

    /**
     * 并行委派（§53）。
     * 部分失败不抛错：失败的任务返回 failed 结果，主 Agent 自行决定如何补救。
     */
    async delegateMany(
        inputs: DelegateTaskInput[],
        ctx: ToolExecutionContext,
        options?: { maxParallel?: number; timeoutMs?: number },
    ): Promise<DelegationResult[]> {
        const depth = ctx.delegationDepth + 1
        const decision = this.deps.stopPolicy.evaluateBeforeDelegation(ctx.delegationDepth)
        if (decision.stop) {
            return inputs.map((input) => rejected(input, decision.detail ?? "已达委派上限"))
        }

        // 子代理配额：超出部分直接拒绝，不排队等待
        const remaining = Math.max(
            0,
            this.deps.budget.budget.maxSubAgents - this.deps.budget.subAgentCount,
        )
        const accepted = inputs.slice(0, remaining)
        const overflow = inputs.slice(remaining)

        const parentToolIds = this.deps.getParentToolIds()
        const maxParallel = Math.max(1, Math.min(options?.maxParallel ?? SUBAGENT_MAX_PARALLEL, accepted.length || 1))
        const timeoutMs = options?.timeoutMs ?? SUBAGENT_DEFAULT_TIMEOUT_MS

        const results: DelegationResult[] = new Array(accepted.length)
        let cursor = 0

        const worker = async () => {
            while (cursor < accepted.length) {
                if (ctx.abortSignal?.aborted) break
                const index = cursor
                cursor += 1
                const input = accepted[index]
                this.deps.budget.countSubAgent()
                this.deps.state.incrementDelegation()

                const contextEvidence = this.deps.selectContextEvidence?.(input.objective) ?? []
                const result = await this.deps.subAgents.run(input, ctx, {
                    depth,
                    parentToolIds,
                    contextEvidence,
                    timeoutMs,
                })
                // 子代理证据并入主 Evidence 池并统一去重（§19/§54），同时同步进 State
                const merged = this.deps.evidence.merge(result.evidence)
                this.deps.state.addEvidence(merged)
                results[index] = { ...result, evidence: merged }
            }
        }

        await Promise.all(Array.from({ length: maxParallel }, () => worker()))

        const cancelled = accepted
            .map((input, index) => results[index] ?? rejected(input, "任务已取消"))
        return [...cancelled, ...overflow.map((input) => rejected(input, "已达子代理数量上限"))]
    }
}

function rejected(input: DelegateTaskInput, reason: string): DelegationResult {
    return {
        taskId: `rejected_${Math.abs(hash(input.objective))}`,
        status: "failed",
        summary: `未执行该子任务：${reason}。请由主 Agent 直接处理或缩小范围。`,
        evidence: [],
        traceId: "",
        durationMs: 0,
    }
}

function hash(value: string): number {
    let out = 0
    for (let i = 0; i < value.length; i += 1) {
        out = (out * 31 + value.charCodeAt(i)) | 0
    }
    return out
}
