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

export type IntentRouteResult = {
    domains: AgentDomainId[]
    confidence: number
    rationale?: string
}

export type AssistantToolContext = {
    userId: number
    threadId: number
    runId: number
    focus: AssistantFocus | null
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
