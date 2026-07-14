import type { z } from "zod"

// 契约来源：.codestable/roadmap/chat-first-universal-agent 第 4.2 / 4.3 节。
// 形状由 roadmap 锁定，要改先走 cs-roadmap update。

export type AgentDomainId =
    | "knowledge"
    | "doc_library"
    | "system"
    | "content_write"
    | "admin"

/** 旁路人格标识（脱离业务的独立 skill 运行时）。目前仅倪海厦。 */
export type AssistantPersona = "nihaixia"

export type AssistantFocus = {
    knowledgeBaseId?: string | null
    libraryId?: string | null
    articleId?: string | null
    documentId?: string | null
    /**
     * 旁路人格：选中后走独立 skill 运行时，完全脱离站内业务，
     * 忽略上面的业务范围字段（不做归属校验、不装载业务域工具/技能）。
     */
    persona?: AssistantPersona | null
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
    /** 当前执行中的研究子代理深度；主助手未设置 */
    spawnDepth?: number
    /** 本轮委派链允许的最大 depth */
    spawnMaxDepth?: number
}

export type AssistantToolRegistration = {
    name: string
    domain: AgentDomainId
    risk: "read" | "write" | "dangerous"
    description: string
    // 契约写作 ZodTypeAny（zod v3 记法）；zod v4 的等价物是 z.ZodType
    inputSchema: z.ZodType
    execute: (ctx: AssistantToolContext, input: unknown) => Promise<unknown>
}

export const DEFAULT_READ_DOMAINS: AgentDomainId[] = ["system", "knowledge", "doc_library"]
