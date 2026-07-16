import { DEFAULT_READ_DOMAINS, type AgentDomainId, type AssistantFocus, type IntentRouteResult } from "./domain-types"
import { getAssistantToolDomain } from "./tool-registry"

// 意图路由骨架（契约 4.2）：规则启发式纯打分，无 LLM 调用。
// 实现可换（规则 / 小模型），返回形状不可改。

/** 写域：装载面含危险确认相关工具 */
export const WRITE_INTENT_DOMAINS = new Set<AgentDomainId>(["content_write", "admin"])

// 写意图用更「动手」的动词；误挂靠「危险工具不暴露 + 确认协议」兜底，不再依赖 LLM 剥写域
const DOMAIN_PATTERNS: Array<{ domain: AgentDomainId; pattern: RegExp; weight: number }> = [
    {
        domain: "content_write",
        pattern: /(新建|创建|写入|删除|移除|移动|迁移|移到|挪到|跨库|move[_-]?article|重命名|归档|上传|保存|发布|撤销分享|开启分享|公开分享|改标题|更新正文|编辑文章|帮我删|帮我建)/i,
        weight: 3,
    },
    { domain: "admin", pattern: /(模型配置|ai\s*配置|密钥|api\s*key|公开问答|公开站|吊销|配额|开关)/i, weight: 3 },
    { domain: "knowledge", pattern: /(知识库|文章|wiki|笔记)/i, weight: 2 },
    { domain: "doc_library", pattern: /(文档|文件|pdf|word|excel|csv)/i, weight: 2 },
    { domain: "system", pattern: /(多少|几个|统计|概览|状态|总数|系统|是否就绪|有没有配置)/, weight: 2 },
]

const FOCUS_DOMAIN_BOOST = 4
/** 主意图域上限（辅助域另计），避免一次装载全站非 dangerous 工具 */
export const MAX_PRIMARY_INTENT_DOMAINS = 2

export function hasWriteDomainCandidate(domains: AgentDomainId[]): boolean {
    return domains.some((domain) => WRITE_INTENT_DOMAINS.has(domain))
}

export function extractWriteDomains(domains: AgentDomainId[] | undefined): AgentDomainId[] {
    if (!domains?.length) return []
    return domains.filter((domain) => WRITE_INTENT_DOMAINS.has(domain))
}

/** 意图 LLM 失败时偏安全：去掉写域，保留只读面（仅用于无规则写命中的降级路径） */
export function stripWriteDomains(domains: AgentDomainId[]): AgentDomainId[] {
    const next = domains.filter((domain) => !WRITE_INTENT_DOMAINS.has(domain))
    if (next.length === 0) return [...DEFAULT_READ_DOMAINS]
    return withAuxiliaryDomains(next)
}

/**
 * 写域粘性：上一轮已激活的写域，本轮继续装载。
 * 根因修复——多轮写入（提议→确认→执行）不能每轮重新过硬门控把工具卸掉。
 */
export function withStickyWriteDomains(
    domains: AgentDomainId[],
    recentIntentDomains?: AgentDomainId[],
): AgentDomainId[] {
    const sticky = extractWriteDomains(recentIntentDomains)
    if (sticky.length === 0) return domains
    const next = [...domains]
    for (const domain of sticky) {
        if (!next.includes(domain)) next.push(domain)
    }
    return withAuxiliaryDomains(next)
}

/**
 * 规则已命中写域时，LLM 不得剥掉（写域保底）。
 * 危险工具仍不对模型暴露；误挂写域的代价远小于「明明有工具却说没有」。
 */
export function mergeWriteDomainsFromRules(
    llmDomains: AgentDomainId[],
    rulesDomains: AgentDomainId[],
): { domains: AgentDomainId[]; kept: boolean } {
    const writeFromRules = extractWriteDomains(rulesDomains)
    if (writeFromRules.length === 0) return { domains: llmDomains, kept: false }
    if (writeFromRules.every((domain) => llmDomains.includes(domain))) {
        return { domains: llmDomains, kept: false }
    }
    const merged = [...llmDomains]
    for (const domain of writeFromRules) {
        if (!merged.includes(domain)) merged.unshift(domain)
    }
    return {
        domains: withAuxiliaryDomains(merged.slice(0, MAX_PRIMARY_INTENT_DOMAINS + 2)),
        kept: true,
    }
}

export async function routeAssistantIntent(input: {
    userText: string
    focus: AssistantFocus | null
    recentToolNames: string[]
    /** 上一轮 run 的意图域；用于写域粘性 */
    recentIntentDomains?: AgentDomainId[]
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

    const primary = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_PRIMARY_INTENT_DOMAINS)
        .map(([domain]) => domain)

    if (primary.length === 0) {
        // 无文本信号时仍可能粘住上一轮写域（例如用户只回「对的」）
        const stickyOnly = withStickyWriteDomains([...DEFAULT_READ_DOMAINS], input.recentIntentDomains)
        const stickyApplied = extractWriteDomains(input.recentIntentDomains).length > 0
            && hasWriteDomainCandidate(stickyOnly)
        return {
            domains: stickyOnly,
            confidence: stickyApplied ? 0.7 : 0.3,
            rationale: stickyApplied
                ? "no-signal:sticky-write-domains"
                : "no-signal:default-read-domains",
        }
    }

    const domains = withStickyWriteDomains(withAuxiliaryDomains(primary), input.recentIntentDomains)
    const sticky = extractWriteDomains(input.recentIntentDomains)
    const rationale = [
        signals.join(","),
        ...(sticky.length > 0 ? [`sticky:${sticky.join("+")}`] : []),
    ].filter(Boolean).join(",")

    return {
        domains,
        confidence: Math.min(0.9, 0.5 + signals.length * 0.1),
        rationale,
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
