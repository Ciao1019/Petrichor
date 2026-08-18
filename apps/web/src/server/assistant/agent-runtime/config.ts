import type { AgentBudget, RouterMode, StopPolicyConfig, TaskComplexity } from "./types"

/**
 * Agent Runtime 配置与 Feature Flag（§107/§93/§92）。
 * 所有开关集中此处，禁止在各文件散落硬编码。
 */

function envFlag(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw == null || raw === "") return fallback
    return raw === "1" || raw.toLowerCase() === "true"
}

function envInt(name: string, fallback: number): number {
    const raw = Number(process.env[name])
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

function envStr(name: string, fallback: string): string {
    const raw = process.env[name]
    return raw && raw.trim() ? raw.trim() : fallback
}

export type AgentFeatureFlags = {
    /** 关闭时 chat-handler 走旧链路（回滚开关） */
    runtimeV2: boolean
    softRouter: boolean
    dynamicSkills: boolean
    delegation: boolean
    bm25: boolean
    rrf: boolean
    rerank: boolean
    debug: boolean
}

export function readAgentFeatureFlags(): AgentFeatureFlags {
    return {
        runtimeV2: envFlag("AGENT_RUNTIME_V2", true),
        softRouter: envFlag("SOFT_ROUTER_ENABLED", true),
        dynamicSkills: envFlag("AGENT_DYNAMIC_SKILLS", true),
        delegation: envFlag("AGENT_DELEGATION", true),
        bm25: envFlag("RAG_BM25", true),
        rrf: envFlag("RAG_RRF", true),
        rerank: envFlag("RAG_RERANK_ENABLED", false),
        debug: envFlag("AGENT_DEBUG", false),
    }
}

export function readRouterMode(): RouterMode {
    return readAgentFeatureFlags().softRouter ? "soft" : "disabled"
}

// ---------------------------------------------------------------------------
// Budget（§62/§63）：按复杂度分级，简单请求不给最大预算
// ---------------------------------------------------------------------------

const BUDGET_BY_COMPLEXITY: Record<TaskComplexity, AgentBudget> = {
    direct: {
        maxIterations: 1,
        maxToolCalls: 0,
        maxExecutionMs: 60_000,
        maxSubAgents: 0,
    },
    simple: {
        maxIterations: 4,
        maxToolCalls: 4,
        maxExecutionMs: 120_000,
        maxSubAgents: 0,
    },
    multi_step: {
        maxIterations: 12,
        maxToolCalls: 14,
        maxExecutionMs: 240_000,
        maxSubAgents: 2,
    },
    complex: {
        maxIterations: 24,
        maxToolCalls: 32,
        maxExecutionMs: 420_000,
        maxSubAgents: 5,
    },
}

export function resolveBudget(complexity: TaskComplexity): AgentBudget {
    const base = BUDGET_BY_COMPLEXITY[complexity]
    const maxTokens = envInt("AGENT_MAX_TOKENS", 0)
    return {
        ...base,
        maxIterations: envInt(`AGENT_MAX_ITERATIONS_${complexity.toUpperCase()}`, base.maxIterations),
        maxToolCalls: envInt(`AGENT_MAX_TOOL_CALLS_${complexity.toUpperCase()}`, base.maxToolCalls),
        maxExecutionMs: envInt("AGENT_MAX_EXECUTION_MS", base.maxExecutionMs),
        ...(maxTokens > 0 ? { maxTokens } : {}),
    }
}

/** 委派最大深度（§51），硬上限 2 */
export const MAX_DELEGATION_DEPTH_LIMIT = 2

export function resolveStopPolicy(complexity: TaskComplexity): StopPolicyConfig {
    const budget = resolveBudget(complexity)
    return {
        ...budget,
        maxDelegationDepth: Math.min(
            envInt("AGENT_MAX_DELEGATION_DEPTH", 2),
            MAX_DELEGATION_DEPTH_LIMIT,
        ),
        maxNoProgressIterations: envInt("AGENT_MAX_NO_PROGRESS", 3),
    }
}

// ---------------------------------------------------------------------------
// 工具执行默认值（§13/§60）
// ---------------------------------------------------------------------------

export const TOOL_DEFAULT_TIMEOUT_MS = envInt("AGENT_TOOL_TIMEOUT_MS", 45_000)
/** 同一 Tool+Args 默认最多 1 次自动重试（§60） */
export const TOOL_DEFAULT_MAX_RETRIES = envInt("AGENT_TOOL_MAX_RETRIES", 1)
export const SUBAGENT_DEFAULT_TIMEOUT_MS = envInt("AGENT_SUBAGENT_TIMEOUT_MS", 120_000)
export const SUBAGENT_MAX_PARALLEL = envInt("AGENT_SUBAGENT_MAX_PARALLEL", 3)

// ---------------------------------------------------------------------------
// Context Budget（§22）
// ---------------------------------------------------------------------------

export type ContextBudgetConfig = {
    total: number
    system: number
    conversation: number
    evidence: number
    observation: number
    skill: number
}

export function resolveContextBudget(total = envInt("AGENT_CONTEXT_TOKENS", 100_000)): ContextBudgetConfig {
    return {
        total,
        system: Math.floor(total * 0.08),
        skill: Math.floor(total * 0.12),
        evidence: Math.floor(total * 0.3),
        observation: Math.floor(total * 0.1),
        conversation: Math.floor(total * 0.4),
    }
}

// ---------------------------------------------------------------------------
// 召回配置（§93）：禁止散落硬编码
// ---------------------------------------------------------------------------

export type RecallConfig = {
    treeTopK: number
    vectorTopK: number
    bm25TopK: number
    fusionTopK: number
    rerankTopK: number
    finalTopK: number
    /** RRF 平滑常数 */
    rrfK: number
    /**
     * Tree 召回超时。它是一次 LLM 目录导航（实测单次约 19s），
     * 必须有上限，否则一次检索就能吃掉整个 Run 的执行预算。
     */
    treeTimeoutMs: number
}

export function resolveRecallConfig(overrides?: Partial<RecallConfig>): RecallConfig {
    const base: RecallConfig = {
        treeTopK: envInt("RAG_TREE_TOP_K", 10),
        vectorTopK: envInt("RAG_VECTOR_TOP_K", 10),
        bm25TopK: envInt("RAG_BM25_TOP_K", 10),
        fusionTopK: envInt("RAG_FUSION_TOP_K", 20),
        rerankTopK: envInt("RAG_RERANK_TOP_N", 10),
        finalTopK: envInt("RAG_FINAL_TOP_K", 10),
        rrfK: envInt("RAG_RRF_K", 60),
        treeTimeoutMs: envInt("RAG_TREE_TIMEOUT_MS", 12_000),
    }
    return { ...base, ...overrides }
}

export type RerankConfig = {
    enabled: boolean
    provider: string
    model: string
    topN: number
    baseUrl?: string
    apiKey?: string
    timeoutMs: number
}

export function resolveRerankConfig(): RerankConfig {
    const flags = readAgentFeatureFlags()
    return {
        enabled: flags.rerank,
        provider: envStr("RAG_RERANK_PROVIDER", "openai-compatible"),
        model: envStr("RAG_RERANK_MODEL", "bge-reranker-v2-m3"),
        topN: envInt("RAG_RERANK_TOP_N", 10),
        ...(process.env.RAG_RERANK_BASE_URL ? { baseUrl: process.env.RAG_RERANK_BASE_URL } : {}),
        ...(process.env.RAG_RERANK_API_KEY ? { apiKey: process.env.RAG_RERANK_API_KEY } : {}),
        timeoutMs: envInt("RAG_RERANK_TIMEOUT_MS", 8_000),
    }
}

/** BM25 字段权重（§27）：title > summary > content */
export type Bm25FieldWeights = { title: number; summary: number; content: number }

export function resolveBm25FieldWeights(): Bm25FieldWeights {
    return {
        title: Number(process.env.RAG_BM25_W_TITLE ?? 3),
        summary: Number(process.env.RAG_BM25_W_SUMMARY ?? 2),
        content: Number(process.env.RAG_BM25_W_CONTENT ?? 1),
    }
}
