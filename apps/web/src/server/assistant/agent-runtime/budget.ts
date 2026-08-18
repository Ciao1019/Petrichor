import { resolveBudget } from "./config"
import type { AgentBudget, TaskComplexity } from "./types"

/**
 * 运行预算跟踪（§62/§63）。
 * 只负责"还剩多少"，是否停止由 StopPolicy 统一裁决。
 */
export class BudgetTracker {
    readonly budget: AgentBudget
    private readonly startedAt: number
    private subAgents = 0

    constructor(complexity: TaskComplexity, options?: { budget?: AgentBudget; now?: number }) {
        this.budget = options?.budget ?? resolveBudget(complexity)
        this.startedAt = options?.now ?? Date.now()
    }

    elapsedMs(now = Date.now()): number {
        return now - this.startedAt
    }

    remainingMs(now = Date.now()): number {
        return Math.max(0, this.budget.maxExecutionMs - this.elapsedMs(now))
    }

    /** 剩余时间不足以再跑一次工具时返回 true，避免起了就必然超时 */
    timeExhausted(now = Date.now()): boolean {
        return this.remainingMs(now) <= 0
    }

    countSubAgent(n = 1): number {
        this.subAgents += n
        return this.subAgents
    }

    get subAgentCount(): number {
        return this.subAgents
    }

    subAgentsExhausted(): boolean {
        return this.subAgents >= this.budget.maxSubAgents
    }

    /**
     * 给单次工具执行分配的超时：不得超过剩余运行时间。
     *
     * 注意下限只作用于「按剩余时间压缩」这一侧：工具自己声明的更短超时必须被尊重，
     * 否则配置了 30ms 的工具会被悄悄放宽到 1s。
     * 剩余时间已耗尽时不再压缩——那属于 StopPolicy 的裁决范围。
     */
    clampToolTimeout(desiredMs: number, now = Date.now()): number {
        const remaining = this.remainingMs(now)
        if (remaining <= 0) return desiredMs
        return Math.min(desiredMs, Math.max(1_000, remaining))
    }
}
