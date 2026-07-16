import type { z } from "zod"

// 契约来源：.codestable/roadmap/chat-first-universal-agent 第 4.2 / 4.3 节。
// 形状由 roadmap 锁定，要改先走 cs-roadmap update。

export type AgentDomainId =
    | "knowledge"
    | "doc_library"
    | "system"
    | "content_write"
    | "admin"

export type AssistantFocus = {
    knowledgeBaseId?: string | null
    libraryId?: string | null
    articleId?: string | null
    documentId?: string | null
}

export type IntentRouteSource = "rules" | "llm"

export type IntentRouteResult = {
    domains: AgentDomainId[]
    confidence: number
    rationale?: string
    /** 路由来源；规则路径默认 rules，LLM 覆盖后为 llm */
    source?: IntentRouteSource
}

export type AssistantToolContext = {
    userId: number
    threadId: number
    runId: number
    focus: AssistantFocus | null
    /** 当前用户 systemRole；操作员门闩 / 专属工具用 */
    systemRole?: string | null
    /** 当前执行中的研究子代理深度；主助手未设置 */
    spawnDepth?: number
    /** 本轮委派链允许的最大 depth */
    spawnMaxDepth?: number
    /** 本轮 chat 请求 AbortSignal；子代理超时/用户停止时贯通取消 */
    abortSignal?: AbortSignal
}

export type AssistantToolRegistration = {
    name: string
    domain: AgentDomainId
    risk: "read" | "write" | "dangerous"
    description: string
    /** 仅操作员装载；非操作员不对模型暴露 */
    requiresOperator?: boolean
    // 契约写作 ZodTypeAny（zod v3 记法）；zod v4 的等价物是 z.ZodType
    inputSchema: z.ZodType
    execute: (ctx: AssistantToolContext, input: unknown) => Promise<unknown>
}

export const DEFAULT_READ_DOMAINS: AgentDomainId[] = ["system", "knowledge", "doc_library"]

/**
 * 会话核心域（对齐 Claude Code：小工具集常驻，不靠意图硬门控藏工具）。
 * dangerous 工具仍由 registry 对模型隐藏，经确认协议执行。
 * admin 不在此列，仍按意图按需装载。
 */
export const CORE_SESSION_DOMAINS: AgentDomainId[] = [
    "system",
    "knowledge",
    "doc_library",
    "content_write",
]

/** 意图域 → 实际工具装载域：核心常驻 ∪ 意图中的 admin */
export function resolveToolLoadDomains(intentDomains: AgentDomainId[]): AgentDomainId[] {
    const next = new Set<AgentDomainId>(CORE_SESSION_DOMAINS)
    for (const domain of intentDomains) {
        if (domain === "admin") next.add("admin")
    }
    return [...next]
}

/** 纯读意图主循环步数上限 */
export const ASSISTANT_MAX_STEPS_READ = 12
/** 含写/管理意图主循环步数上限 */
export const ASSISTANT_MAX_STEPS_WRITE = 20

/**
 * 按意图芯片域决定主循环 maxSteps（不用常驻 toolDomains，避免永远写档）。
 * 意图含 content_write 或 admin → 20，否则 12。
 */
export function resolveAssistantMaxSteps(intentDomains: AgentDomainId[]): number {
    if (intentDomains.includes("content_write") || intentDomains.includes("admin")) {
        return ASSISTANT_MAX_STEPS_WRITE
    }
    return ASSISTANT_MAX_STEPS_READ
}

export const STEP_BUDGET_PART_TYPE = "data-step-budget"

export type StepBudgetPartData = {
    status: "warning" | "exhausted"
    used: number
    limit: number
    label: string
}

/** 落库时去掉 warning（瞬时提示），保留 exhausted 供刷新后继续提示用户续跑 */
export function stripStepBudgetWarnings(parts: unknown): unknown[] {
    if (!Array.isArray(parts)) return []
    return parts.filter((part) => {
        if (!part || typeof part !== "object") return true
        const record = part as { type?: unknown; data?: unknown }
        if (record.type !== STEP_BUDGET_PART_TYPE) return true
        const data = record.data
        if (!data || typeof data !== "object") return true
        return (data as { status?: unknown }).status !== "warning"
    })
}