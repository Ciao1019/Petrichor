import { DEFAULT_READ_DOMAINS, type AgentDomainId, type AssistantFocus, type IntentRouteResult } from "./domain-types"
import { getAssistantToolDomain } from "./tool-registry"

// 意图路由骨架（契约 4.2）：规则启发式纯打分，无 LLM 调用。
// 实现可换（规则 / 小模型），返回形状不可改。

const DOMAIN_PATTERNS: Array<{ domain: AgentDomainId; pattern: RegExp; weight: number }> = [
    { domain: "content_write", pattern: /(新建|创建|添加|写入|修改|更新|编辑|删除|移除|移动|重命名|归档|上传|保存|发布|撤销|分享)/, weight: 3 },
    { domain: "admin", pattern: /(模型配置|ai\s*配置|密钥|api\s*key|公开问答|公开站|吊销|配额|开关)/i, weight: 3 },
    { domain: "knowledge", pattern: /(知识库|文章|wiki|笔记)/i, weight: 2 },
    { domain: "doc_library", pattern: /(文档|文件|pdf|word|excel|csv)/i, weight: 2 },
    { domain: "system", pattern: /(多少|几个|统计|概览|状态|总数|系统|是否就绪|有没有配置)/, weight: 2 },
]

const FOCUS_DOMAIN_BOOST = 4

export async function routeAssistantIntent(input: {
    userText: string
    focus: AssistantFocus | null
    recentToolNames: string[]
}): Promise<IntentRouteResult> {
    const scores = new Map<AgentDomainId, number>()
    const signals: string[] = []
    const bump = (domain: AgentDomainId, weight: number, signal: string) => {
        scores.set(domain, (scores.get(domain) ?? 0) + weight)
        signals.push(signal)
    }

    for (const { domain, pattern, weight } of DOMAIN_PATTERNS) {
        if (pattern.test(input.userText)) bump(domain, weight, `text:${domain}`)
    }

    const focus = input.focus
    if (focus?.knowledgeBaseId != null || focus?.articleId != null) {
        bump("knowledge", FOCUS_DOMAIN_BOOST, "focus:knowledge")
    }
    if (focus?.libraryId != null || focus?.documentId != null) {
        bump("doc_library", FOCUS_DOMAIN_BOOST, "focus:doc_library")
    }

    for (const toolName of new Set(input.recentToolNames)) {
        const domain = getAssistantToolDomain(toolName)
        if (domain) bump(domain, 1, `recent:${toolName}`)
    }

    const domains = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([domain]) => domain)

    if (domains.length === 0) {
        return { domains: [...DEFAULT_READ_DOMAINS], confidence: 0.3, rationale: "no-signal:default-read-domains" }
    }
    return {
        domains: withAuxiliaryDomains(domains),
        confidence: Math.min(0.9, 0.5 + signals.length * 0.1),
        rationale: signals.join(","),
    }
}

/** knowledge/doc_library → 补 system；admin → 补 content_write（确认工具） */
export function withAuxiliaryDomains(domains: AgentDomainId[]): AgentDomainId[] {
    let next = domains
    if ((next.includes("knowledge") || next.includes("doc_library")) && !next.includes("system")) {
        next = [...next, "system"]
    }
    if (next.includes("admin") && !next.includes("content_write")) {
        next = [...next, "content_write"]
    }
    return next
}
