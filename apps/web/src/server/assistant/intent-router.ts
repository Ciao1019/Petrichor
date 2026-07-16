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

export function hasAdminDomainCandidate(domains: AgentDomainId[]): boolean {
    return domains.includes("admin")
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
 * admin 粘性：上一轮已激活 admin 时本轮继续挂载（admin 仍按意图按需装载）。
 * content_write 已会话常驻，不再粘性。
 */
export function withStickyAdminDomain(
    domains: AgentDomainId[],
    recentIntentDomains?: AgentDomainId[],
): AgentDomainId[] {
    if (!recentIntentDomains?.includes("admin")) return domains
    if (domains.includes("admin")) return domains
    return withAuxiliaryDomains([...domains, "admin"])
}

/** @deprecated 使用 withStickyAdminDomain；保留别名避免外部误用旧名静默失败 */
export const withStickyWriteDomains = withStickyAdminDomain

/**
 * 规则已命中 admin 时，LLM 不得剥掉（admin 保底）。
 * content_write 常驻装载，不再做写域保底。
 */
export function mergeAdminDomainFromRules(
    llmDomains: AgentDomainId[],
    rulesDomains: AgentDomainId[],
): { domains: AgentDomainId[]; kept: boolean } {
    if (!rulesDomains.includes("admin")) return { domains: llmDomains, kept: false }
    if (llmDomains.includes("admin")) return { domains: llmDomains, kept: false }
    return {
        domains: withAuxiliaryDomains(
            (["admin", ...llmDomains] as AgentDomainId[]).slice(0, MAX_PRIMARY_INTENT_DOMAINS + 2),
        ),
        kept: true,
    }
}

/** @deprecated 使用 mergeAdminDomainFromRules */
export const mergeWriteDomainsFromRules = mergeAdminDomainFromRules

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
        // 无文本信号时仍可能粘住上一轮 admin（例如多轮管理操作中的短确认）
        const stickyOnly = withStickyAdminDomain([...DEFAULT_READ_DOMAINS], input.recentIntentDomains)
        const stickyApplied = hasAdminDomainCandidate(stickyOnly)
            && Boolean(input.recentIntentDomains?.includes("admin"))
        return {
            domains: stickyOnly,
            confidence: stickyApplied ? 0.7 : 0.3,
            rationale: stickyApplied
                ? "no-signal:sticky-admin-domain"
                : "no-signal:default-read-domains",
        }
    }

    const domains = withStickyAdminDomain(withAuxiliaryDomains(primary), input.recentIntentDomains)
    const stickyAdmin = input.recentIntentDomains?.includes("admin") && domains.includes("admin")
    const rationale = [
        signals.join(","),
        ...(stickyAdmin ? ["sticky:admin"] : []),
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
