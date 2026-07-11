import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import {
    type AgentDomainId,
    type AssistantFocus,
    type IntentRouteResult,
    type IntentRouteSource,
} from "./domain-types"
import { routeAssistantIntent, withAuxiliaryDomains } from "./intent-router"

export const INTENT_LLM_CONFIDENCE_THRESHOLD = 0.5
export const INTENT_LLM_TIMEOUT_MS = 5_000
export const INTENT_ROUTE_PART_TYPE = "data-intent-route"

const AGENT_DOMAIN_IDS = [
    "knowledge",
    "doc_library",
    "system",
    "content_write",
    "admin",
] as const satisfies readonly AgentDomainId[]

export const DOMAIN_LABELS: Record<AgentDomainId, string> = {
    knowledge: "知识库",
    doc_library: "文档库",
    system: "系统",
    content_write: "内容写入",
    admin: "管理",
}

const intentLlmSchema = z.object({
    domains: z.array(z.enum(AGENT_DOMAIN_IDS)).min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(80),
})

export type IntentRouteUiResult = IntentRouteResult & {
    source: IntentRouteSource
}

export type IntentRoutePartData = {
    status: "running" | "done"
    source?: IntentRouteSource
    domains?: AgentDomainId[]
    confidence?: number
    rationale?: string
    label: string
}

export function needsIntentLlm(route: IntentRouteResult): boolean {
    return route.confidence < INTENT_LLM_CONFIDENCE_THRESHOLD
}

export function formatIntentRouteLabel(input: {
    domains: AgentDomainId[]
    source: IntentRouteSource
    confidence: number
}): string {
    const domainText = input.domains.map((domain) => DOMAIN_LABELS[domain] ?? domain).join(" · ")
    const sourceText = input.source === "llm" ? "智能识别" : "规则"
    const confidenceText = `${Math.round(input.confidence * 100)}%`
    return `${domainText}（${sourceText} · ${confidenceText}）`
}

export function toIntentRoutePartData(
    route: IntentRouteUiResult,
    status: "running" | "done" = "done",
): IntentRoutePartData {
    if (status === "running") {
        return { status: "running", label: "正在识别意图…" }
    }
    return {
        status: "done",
        source: route.source,
        domains: route.domains,
        confidence: route.confidence,
        rationale: route.rationale,
        label: formatIntentRouteLabel(route),
    }
}

export function domainsEqual(a: AgentDomainId[], b: AgentDomainId[]): boolean {
    if (a.length !== b.length) return false
    return a.every((domain, index) => domain === b[index])
}

/** 同一条助手消息里只保留最后一条 intent-route（防御 id 合并失败或历史脏数据） */
export function dedupeIntentRouteParts(parts: unknown): unknown[] {
    if (!Array.isArray(parts)) return []
    let lastIntentIndex = -1
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]
        if (!part || typeof part !== "object") continue
        if ((part as { type?: unknown }).type === INTENT_ROUTE_PART_TYPE) {
            lastIntentIndex = index
        }
    }
    if (lastIntentIndex < 0) return parts
    return parts.filter((part, index) => {
        if (!part || typeof part !== "object") return true
        if ((part as { type?: unknown }).type !== INTENT_ROUTE_PART_TYPE) return true
        return index === lastIntentIndex
    })
}

/**
 * 规则优先；低置信度时用轻量 generateObject 覆盖。
 * LLM 失败 / 超时 / abort 时静默回退规则结果，不阻断对话。
 */
export async function routeAssistantIntentWithLlm(input: {
    userText: string
    focus: AssistantFocus | null
    recentToolNames: string[]
    model: LanguageModel
    signal?: AbortSignal
    /** 若调用方已跑过规则，传入可避免重复打分 */
    rulesRoute?: IntentRouteResult
}): Promise<IntentRouteUiResult> {
    const rules = input.rulesRoute ?? await routeAssistantIntent({
        userText: input.userText,
        focus: input.focus,
        recentToolNames: input.recentToolNames,
    })
    const rulesResult: IntentRouteUiResult = { ...rules, source: "rules" }

    if (!needsIntentLlm(rules)) {
        return rulesResult
    }

    try {
        const llm = await classifyIntentWithLlm({
            userText: input.userText,
            focus: input.focus,
            recentToolNames: input.recentToolNames,
            rules,
            model: input.model,
            signal: input.signal,
        })
        return llm
    } catch {
        return rulesResult
    }
}

export async function classifyIntentWithLlm(input: {
    userText: string
    focus: AssistantFocus | null
    recentToolNames: string[]
    rules: IntentRouteResult
    model: LanguageModel
    signal?: AbortSignal
}): Promise<IntentRouteUiResult> {
    const focusHint = summarizeFocus(input.focus)
    const recentHint = input.recentToolNames.length > 0
        ? input.recentToolNames.slice(0, 8).join(", ")
        : "无"

    const timeout = AbortSignal.timeout(INTENT_LLM_TIMEOUT_MS)
    const abortSignal = input.signal
        ? AbortSignal.any([input.signal, timeout])
        : timeout

    const result = await generateObject({
        model: input.model,
        schema: intentLlmSchema,
        temperature: 0,
        abortSignal,
        system: [
            "你是 Petrichor 站内助手的意图分类器。",
            "只输出 JSON，选择本轮需要装载的工具域。",
            "可选域：knowledge（知识库）、doc_library（文档库）、system（系统概览/进度/引用）、content_write（写文章/分享）、admin（模型配置/API Key/公开问答）。",
            "规则：写/删/改内容必须含 content_write；管理面必须含 admin；知识库或文档库问答通常同时含 system（便于引用与进度）。",
            "rationale 用中文短句说明理由，不超过 80 字。",
            "不要编造域；不确定时优先只读域 system/knowledge/doc_library。",
        ].join("\n"),
        prompt: [
            `用户消息：${input.userText || "（空）"}`,
            `当前 focus：${focusHint}`,
            `近期工具：${recentHint}`,
            `规则初筛 domains：${input.rules.domains.join(", ")}`,
            `规则置信度：${input.rules.confidence}`,
            `规则 rationale：${input.rules.rationale ?? ""}`,
        ].join("\n"),
    })

    const domains = withAuxiliaryDomains(result.object.domains)
    return {
        domains,
        confidence: result.object.confidence,
        rationale: result.object.rationale.trim(),
        source: "llm",
    }
}

function summarizeFocus(focus: AssistantFocus | null): string {
    if (!focus) return "无"
    const parts: string[] = []
    if (focus.knowledgeBaseId != null) parts.push(`knowledgeBaseId=${focus.knowledgeBaseId}`)
    if (focus.articleId != null) parts.push(`articleId=${focus.articleId}`)
    if (focus.libraryId != null) parts.push(`libraryId=${focus.libraryId}`)
    if (focus.documentId != null) parts.push(`documentId=${focus.documentId}`)
    return parts.length > 0 ? parts.join(", ") : "无"
}
