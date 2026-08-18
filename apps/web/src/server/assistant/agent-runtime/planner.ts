import type { AgentPlanStep, RoutingHint, TaskComplexity } from "./types"

/**
 * 复杂度识别与计划管理（§7/§8/§83/§135）。
 *
 * 复杂度只是策略提示：它决定预算与是否生成计划，绝不限制 Agent 实际能做什么。
 * 判定走规则，简单请求因此不会因为重构多出一次 LLM 调用。
 */

export type ComplexitySignal = {
    id: string
    weight: number
    matched: boolean
    detail?: string
}

export type ComplexityDecision = {
    complexity: TaskComplexity
    reason: string
    score: number
    signals: ComplexitySignal[]
}

export type ComplexityInput = {
    goal: string
    routingHint?: RoutingHint | null
    /** 会话已有轮次，长会话更可能是延续性复杂任务 */
    turnCount?: number
    /** 是否锁定了知识库/文档等 focus */
    hasFocus?: boolean
}

/** 明显不需要工具的寒暄/常识/纯计算 */
const DIRECT_PATTERNS = [
    /^\s*(你好|hi|hello|在吗|谢谢|thanks?)\s*[!！。.]*$/i,
    /^\s*\d+\s*[+\-*/×÷]\s*\d+\s*(=|等于)?\s*(多少|几)?\s*[?？。.!！]*\s*$/,
    /^\s*(你是谁|你能做什么|介绍一下你自己)\s*[?？]?\s*$/,
]

/** 需要外部资料的信号 */
const RESEARCH_PATTERNS = [
    /官方|最新|近期|当前版本|业界|社区|发布|release|changelog/i,
    /查(一下|查)?(网上|外部|公开)/,
    /对比.*(官方|业界|市面|开源)/,
]

/** 多子任务 / 比较 / 综合分析信号 */
const COMPLEX_PATTERNS = [
    /分别(研究|调研|分析|对比)/,
    /(对比|比较).{0,20}(和|与|vs).{0,20}(的|之间)?/i,
    /技术选型|方案选型|可行性分析|风险(评估|清单|分析)/,
    /(写|生成|输出)(一份|一篇)?(技术方案|设计文档|调研报告|白皮书|方案)/,
    /全面(分析|梳理|评估)/,
]

/** 多步检索信号 */
const MULTI_STEP_PATTERNS = [
    /为什么|原因|怎么(做|实现|修|解决)|如何(实现|优化|排查)/,
    /哪些.*(依赖|关联|影响)/,
    /在哪里|哪个模块|定位/,
    /先.*(再|然后|接着)/,
]

/** 单步就能覆盖的知识检索 */
const SIMPLE_PATTERNS = [
    /是什么|什么是|定义|含义/,
    /有多少|列出|清单|列表/,
    /怎么部署|部署方式|配置在哪/,
]

export function detectComplexity(input: ComplexityInput): ComplexityDecision {
    const goal = input.goal.trim()
    const signals: ComplexitySignal[] = []

    if (!goal) {
        return { complexity: "direct", reason: "空目标", score: 0, signals }
    }

    const direct = DIRECT_PATTERNS.some((pattern) => pattern.test(goal))
    signals.push({ id: "direct_pattern", weight: 0, matched: direct })
    if (direct) {
        return { complexity: "direct", reason: "寒暄/常识类问题，直接回答", score: 0, signals }
    }

    let score = 0
    const push = (id: string, weight: number, matched: boolean, detail?: string) => {
        signals.push({ id, weight, matched, ...(detail ? { detail } : {}) })
        if (matched) score += weight
    }

    // 多个复杂信号要叠加：例如"分别研究 A、B"+"技术选型"应当判为 complex 而不是 multi_step
    const complexMatches = COMPLEX_PATTERNS.filter((pattern) => pattern.test(goal)).length
    signals.push({ id: "complex_pattern", weight: 3, matched: complexMatches > 0, detail: "多子任务/比较/综合分析" })
    score += Math.min(6, complexMatches * 3)
    push("research_pattern", 2, RESEARCH_PATTERNS.some((p) => p.test(goal)), "需要外部资料")
    push("multi_step_pattern", 2, MULTI_STEP_PATTERNS.some((p) => p.test(goal)), "需要多轮检索")
    push("simple_pattern", -1, SIMPLE_PATTERNS.some((p) => p.test(goal)), "单步检索足够")
    push("long_goal", 1, goal.length >= 60, "目标描述较长")
    push("very_long_goal", 1, goal.length >= 140, "目标描述很长")
    push("multi_clause", 1, countClauses(goal) >= 3, "包含多个诉求")
    push("multi_domain", 2, (input.routingHint?.domains.length ?? 0) >= 2, "跨多个域")
    push("long_conversation", 1, (input.turnCount ?? 0) >= 12, "长会话延续任务")
    push("has_focus", -1, input.hasFocus === true, "已锁定检索范围")

    const complexity: TaskComplexity = score >= 5
        ? "complex"
        : score >= 2
            ? "multi_step"
            : "simple"

    const matched = signals.filter((signal) => signal.matched && signal.weight > 0).map((signal) => signal.detail ?? signal.id)
    const reason = matched.length > 0 ? matched.join("、") : "单步或少量工具即可完成"

    return { complexity, reason, score, signals }
}

/** 只有复杂任务才生成计划（§7）：简单请求不得被强制规划 */
export function shouldCreatePlan(complexity: TaskComplexity): boolean {
    return complexity === "complex"
}

/** 委派对简单任务没有价值（§50） */
export function allowsDelegation(complexity: TaskComplexity): boolean {
    return complexity === "complex" || complexity === "multi_step"
}

function countClauses(goal: string): number {
    return goal.split(/[，,；;。.？?！!、和以及并且然后再]+/).filter((part) => part.trim().length >= 4).length
}

/**
 * 计划推进：返回下一个可执行步骤（依赖已完成且自身 pending）。
 * 计划不是 DAG 执行器——它只给 Agent 一个进度视图，Agent 随时可以改。
 */
export function nextActionableStep(plan: AgentPlanStep[]): AgentPlanStep | null {
    const doneIds = new Set(
        plan.filter((step) => step.status === "completed" || step.status === "skipped").map((step) => step.id),
    )
    return plan.find((step) => {
        if (step.status !== "pending") return false
        return (step.dependsOn ?? []).every((id) => doneIds.has(id))
    }) ?? null
}

export function planProgress(plan: AgentPlanStep[]): { done: number; total: number; allDone: boolean } {
    const total = plan.length
    const done = plan.filter((step) => step.status === "completed" || step.status === "skipped").length
    return { done, total, allDone: total > 0 && done === total }
}
