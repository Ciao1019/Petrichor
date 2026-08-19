import type { BudgetTracker } from "./budget"
import type { LoopDetector, LoopSignal } from "./loop-detector"
import type { AgentState, AgentStopReason, StopDecision, StopPolicyConfig } from "./types"

/**
 * 统一停止裁决（§56/§57/§106）。
 *
 * 每轮推理前 / 每次工具执行后调用；只要返回 stop=true，Runtime 必须收敛去生成答案，
 * 而不是硬中断——已有 Evidence 仍应用来回答，并说明局限。
 */
export class StopPolicy {
    constructor(
        readonly config: StopPolicyConfig,
        private readonly budget: BudgetTracker,
        private readonly loopDetector: LoopDetector,
    ) {}

    /** 循环前检查：预算是否还允许再迭代一轮 */
    evaluateBeforeIteration(state: AgentState, now = Date.now()): StopDecision {
        if (state.iteration >= this.config.maxIterations) {
            return stop("max_iterations", `已达最大迭代次数 ${this.config.maxIterations}`)
        }
        if (this.budget.timeExhausted(now)) {
            return stop("max_execution_time", `已达最大执行时长 ${this.config.maxExecutionMs}ms`)
        }
        if (this.config.maxTokens != null && state.tokenUsage.total >= this.config.maxTokens) {
            return stop("max_tokens", `已达 token 上限 ${this.config.maxTokens}`)
        }
        return CONTINUE
    }

    /** 工具执行后检查：工具预算、循环、无进展 */
    evaluateAfterToolCall(state: AgentState, now = Date.now()): StopDecision {
        if (state.toolCallCount >= this.config.maxToolCalls) {
            if (state.evidence.length > 0) {
                return stop(
                    "enough_evidence",
                    `已取得 ${state.evidence.length} 条证据，停止继续调用工具并进入最终作答`,
                )
            }
            return stop("max_tool_calls", `已达最大工具调用次数 ${this.config.maxToolCalls}`)
        }
        if (this.budget.timeExhausted(now)) {
            return stop("max_execution_time", `已达最大执行时长 ${this.config.maxExecutionMs}ms`)
        }

        const signal = this.loopDetector.detect()
        if (signal) return fromLoopSignal(signal)

        if (this.loopDetector.noProgressStreak() >= this.config.maxNoProgressIterations) {
            return stop(
                "no_progress",
                `连续 ${this.config.maxNoProgressIterations} 次工具调用没有新增证据`,
            )
        }
        return CONTINUE
    }

    /** 委派前检查：深度与子代理数量 */
    evaluateBeforeDelegation(depth: number): StopDecision {
        if (depth >= this.config.maxDelegationDepth) {
            return stop("max_delegation_depth", `委派深度已达上限 ${this.config.maxDelegationDepth}`)
        }
        if (this.budget.subAgentsExhausted()) {
            return stop("max_tool_calls", `子代理数量已达上限 ${this.config.maxSubAgents}`)
        }
        return CONTINUE
    }

    /** 剩余可用工具调用次数，用于提示模型收敛 */
    remainingToolCalls(state: AgentState): number {
        return Math.max(0, this.config.maxToolCalls - state.toolCallCount)
    }
}

const CONTINUE: StopDecision = { stop: false }

function stop(reason: AgentStopReason, detail: string): StopDecision {
    return { stop: true, reason, detail }
}

export function fromLoopSignal(signal: LoopSignal): StopDecision {
    switch (signal.kind) {
        case "exact_repeat":
            return stop("loop_detected", `工具 ${signal.toolId} 连续 ${signal.times} 次相同参数调用`)
        case "pattern_loop":
            return stop("loop_detected", `检测到调用环：${signal.pattern.join(" → ")}`)
        case "duplicate_search":
            return stop("loop_detected", `重复检索 ${signal.toolId}，结果未变化`)
        case "no_evidence_progress":
            return stop("no_progress", `连续 ${signal.calls} 次工具调用没有新增证据`)
    }
}

/** 面向普通用户的停止文案（§162.26）：不暴露内部策略名 */
export function describeStopReasonForUser(reason: AgentStopReason | undefined): string | null {
    switch (reason) {
        case undefined:
        case "goal_completed":
        case "enough_evidence":
            return null
        case "cancelled":
            return "已停止。"
        case "permission_denied":
            return "当前账号没有执行该操作的权限，任务已停止。"
        case "fatal_error":
            return "执行过程中出现问题，任务已停止。"
        default:
            return "任务执行已停止，因为暂时无法获得更多有效信息。"
    }
}
