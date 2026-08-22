import { resolveContextBudget, type ContextBudgetConfig } from "./config"
import type { EvidenceStore } from "./evidence"
import { renderObservation, type ObservationStore } from "./observation"
import { BASE_AGENT_PROMPT } from "./prompts/base-agent"
import { buildAnswerQualityGuidance } from "./answer-quality"
import { renderSkillCatalog } from "./skill-registry"
import { renderToolCatalogLine } from "./tool-registry"
import type {
    AgentEvidence,
    AgentPlanStep,
    AgentState,
    AgentSkill,
    AgentToolDefinition,
} from "./types"

/**
 * Context Manager（§21/§22/§23）。
 *
 * 每轮推理只组装：
 *   System Prompt + Current Goal + Plan + State Summary + 已加载 Skill 指令
 *   + 相关 Evidence + 最近 Observation + 最近对话
 *
 * 明确禁止：全量对话 + 全部原始工具结果 + 全部文档 无限增长。
 */

export type ConversationSummary = {
    goals: string[]
    decisions: string[]
    importantFacts: string[]
    unresolvedQuestions: string[]
}

export type ContextBuildInput = {
    state: AgentState
    observations: ObservationStore
    evidence: EvidenceStore
    /** 已加载 skill 的指令 */
    skillInstructions: Array<{ skillId: string; instructions: string }>
    /** 未加载的 skill 目录（只给一行描述） */
    skillCatalog: AgentSkill[]
    /** 当前可用工具（核心 + 已解锁） */
    tools: AgentToolDefinition[]
    /** 最近对话消息（已由上层裁剪成 UI/Model 消息） */
    recentMessages: unknown[]
    /** 长会话摘要（§23） */
    conversationSummary?: ConversationSummary | null
    /** 既有上下文压缩器产出的持久摘要 + 相关历史片段；避免再做一次摘要 LLM */
    conversationBackground?: string | null
    /** Router 提示，只作提示（§5） */
    routingHint?: { domains: string[]; confidence: number } | null
    /** 模式级指令补充（如 Wiki 问答模式的检索与引用规范），插在目标之前 */
    modeGuidance?: string | null
    /** 当前问答模式；wiki 时证据区会给出 [[pageKey|标题]] 引用规则 */
    qaMode?: "normal" | "wiki"
    remainingToolCalls?: number
    budget?: ContextBudgetConfig
}

export type BuiltContext = {
    /** 注入给 Agent 的 system instructions */
    instructions: string
    /** 实际带进 context 的证据（Top-N 且去重后） */
    usedEvidence: AgentEvidence[]
    /** 各分区估算 token */
    tokens: {
        system: number
        skill: number
        evidence: number
        observation: number
        total: number
    }
    /** 被裁掉的内容统计，供 Debug UI 展示 */
    dropped: { evidence: number; observations: number }
}

export class ContextManager {
    private readonly budget: ContextBudgetConfig

    constructor(budget?: ContextBudgetConfig) {
        this.budget = budget ?? resolveContextBudget()
    }

    build(input: ContextBuildInput): BuiltContext {
        const budget = input.budget ?? this.budget
        const sections: string[] = [BASE_AGENT_PROMPT]

        // --- 工具目录 -------------------------------------------------------
        if (input.tools.length > 0) {
            sections.push(`## 当前可用工具\n${input.tools.map(renderToolCatalogLine).join("\n")}`)
        }

        // --- 能力目录（未加载的只给一行）------------------------------------
        const notLoaded = input.skillCatalog.filter((skill) => !input.state.loadedSkills.includes(skill.id))
        const catalog = renderSkillCatalog(notLoaded)
        if (catalog) sections.push(`## 可加载能力\n${catalog}`)

        const systemTokens = estimateTokens(sections.join("\n\n"))

        // --- 已加载 Skill 指令（受 skill budget 限制）------------------------
        const skillBlocks: string[] = []
        let skillTokens = 0
        for (const item of input.skillInstructions) {
            const cost = estimateTokens(item.instructions)
            if (skillTokens + cost > budget.skill) break
            skillTokens += cost
            skillBlocks.push(item.instructions)
        }
        if (skillBlocks.length > 0) {
            sections.push(`## 已加载能力说明\n\n${skillBlocks.join("\n\n")}`)
        }

        // --- 目标与状态 -----------------------------------------------------
        if (input.modeGuidance?.trim()) {
            sections.push(input.modeGuidance.trim())
        }
        sections.push(`## 当前目标\n${input.state.goal}`)
        sections.push(`## 回答质量要求\n${buildAnswerQualityGuidance(input.state.goal)}`)

        if (input.routingHint?.domains.length) {
            sections.push(
                `## 场景提示（仅供参考，不限制你的能力）\n`
                + `可能相关：${input.routingHint.domains.join("、")}（置信度 ${input.routingHint.confidence.toFixed(2)}）。`
                + `即使提示不准，你依然可以加载任何需要的能力。`,
            )
        }

        if (input.conversationSummary) {
            const summary = renderConversationSummary(input.conversationSummary)
            if (summary) sections.push(`## 会话背景\n${summary}`)
        }
        if (input.conversationBackground?.trim()) {
            sections.push(`## 较早会话背景\n${input.conversationBackground.trim()}`)
        }

        if (input.state.plan.length > 0) {
            sections.push(`## 当前计划\n${renderPlan(input.state.plan)}`)
        }

        sections.push(`## 执行状态\n${renderStateSummary(input.state, input.remainingToolCalls)}`)

        // --- 证据（Top-N，受 evidence budget 限制）---------------------------
        const allEvidence = input.evidence.all
        const ranked = input.evidence.topN(allEvidence.length)
        const usedEvidence: AgentEvidence[] = []
        let evidenceTokens = 0
        for (const evidence of ranked) {
            const rendered = renderEvidence(evidence, input.evidence.citationIndex(evidence.id))
            const cost = estimateTokens(rendered)
            // 装不下就跳过这一条继续看下一条：全文类证据（整张 Wiki 页面）可能单条很大，
            // 若在这里 break，它后面所有小片段证据都会被一并丢掉。
            if (evidenceTokens + cost > budget.evidence) continue
            evidenceTokens += cost
            usedEvidence.push(evidence)
        }
        if (usedEvidence.length > 0) {
            const lines = usedEvidence.map((evidence) =>
                renderEvidence(evidence, input.evidence.citationIndex(evidence.id)))
            const evidenceHeader = input.qaMode === "wiki"
                ? `## 已获取证据\n引用 Wiki 页面证据时，在正文中内联写成 [[pageKey|页面标题]]（每条证据的「Wiki 引用」提示里有现成格式）；不要输出 [n] 角标。\n${lines.join("\n\n")}`
                // 普通模式同样鼓励 Wiki 内联引用：前端会把手绘波浪线链接渲染出来供点击查阅。
                // 明确「每个页面各自链一次」，避免模型只链第一个词就停手。
                : `## 已获取证据\n`
                    + `引用 Wiki 页面证据（带「Wiki 引用」提示）时，必须内联引用：每条 Wiki 证据在其支撑的表述处写成 [[pageKey|页面标题]]（照抄提示里的现成格式）；`
                    + `检索结果里带 pageKey 的其他 Wiki 页面，正文明确提及时也可按此格式链接。`
                    + `不同页面要分别引用、不要只链其中一个；同一页面多次提及只在首次加链接。其他来源在句末标注 [n]，n 为证据编号。\n${lines.join("\n\n")}`
            sections.push(evidenceHeader)
        }

        // --- 观察（最近优先，老的压缩成一行统计）-----------------------------
        const observations = input.observations.all
        const kept: string[] = []
        let observationTokens = 0
        let droppedObservations = 0
        for (let i = observations.length - 1; i >= 0; i -= 1) {
            const rendered = renderObservation(observations[i])
            const cost = estimateTokens(rendered)
            if (observationTokens + cost > budget.observation) {
                droppedObservations = i + 1
                break
            }
            observationTokens += cost
            kept.unshift(rendered)
        }
        if (kept.length > 0) {
            const prefix = droppedObservations > 0
                ? `（更早的 ${droppedObservations} 条观察已折叠）\n`
                : ""
            sections.push(`## 最近执行观察\n${prefix}${kept.join("\n")}`)
        }

        if (input.state.openQuestions.length > 0) {
            sections.push(`## 待解决问题\n${input.state.openQuestions.map((q) => `- ${q}`).join("\n")}`)
        }

        const instructions = sections.join("\n\n")

        return {
            instructions,
            usedEvidence,
            tokens: {
                system: systemTokens,
                skill: skillTokens,
                evidence: evidenceTokens,
                observation: observationTokens,
                total: estimateTokens(instructions),
            },
            dropped: {
                evidence: Math.max(0, allEvidence.length - usedEvidence.length),
                observations: droppedObservations,
            },
        }
    }

    /** 最近对话预算（§22）：从后往前保留，超预算就丢更早的 */
    trimConversation(messages: unknown[], budget = this.budget.conversation): unknown[] {
        const kept: unknown[] = []
        let tokens = 0
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const cost = estimateTokens(JSON.stringify(messages[i] ?? ""))
            if (tokens + cost > budget && kept.length > 0) break
            tokens += cost
            kept.unshift(messages[i])
        }
        return kept
    }
}

/** 粗估 token：中文按 ~1.5 字/token，英文按 4 字符/token，够做预算阈值 */
export function estimateTokens(text: string): number {
    if (!text) return 0
    const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length
    const rest = text.length - cjk
    return Math.ceil(cjk / 1.5 + rest / 4)
}

export function renderPlan(plan: AgentPlanStep[]): string {
    const icon: Record<AgentPlanStep["status"], string> = {
        completed: "✓",
        running: "●",
        pending: "○",
        skipped: "-",
        failed: "✗",
    }
    return plan
        .map((step) => {
            const summary = step.resultSummary ? `\n    → ${step.resultSummary}` : ""
            return `${icon[step.status]} ${step.goal}${summary}`
        })
        .join("\n")
}

export function renderStateSummary(state: AgentState, remainingToolCalls?: number): string {
    const lines = [
        `- 迭代轮次：${state.iteration}`,
        `- 工具调用：${state.toolCallCount} 次`,
        `- 已获取证据：${state.evidence.length} 条`,
    ]
    if (state.loadedSkills.length > 0) {
        lines.push(`- 已加载能力：${state.loadedSkills.join("、")}`)
    }
    if (state.delegationCount > 0) {
        lines.push(`- 已委派子任务：${state.delegationCount} 个`)
    }
    if (remainingToolCalls != null) {
        lines.push(
            remainingToolCalls <= 2
                ? `- 剩余工具调用预算：${remainingToolCalls} 次（请尽快收敛并作答）`
                : `- 剩余工具调用预算：${remainingToolCalls} 次`,
        )
    }
    return lines.join("\n")
}

export function renderEvidence(evidence: AgentEvidence, index: number): string {
    const parts = [`[${index}] (${evidence.source}) ${evidence.title ?? "未命名"}`]
    const location = evidence.url ?? (evidence.metadata?.path as string[] | undefined)?.join(" / ")
    if (location) parts.push(`  来源：${location}`)
    if (evidence.metadata?.publishedAt) parts.push(`  时间：${String(evidence.metadata.publishedAt)}`)
    // Wiki 页面证据直接给出可复制的内联引用格式，模型照抄即可
    const pageKey = evidence.metadata?.pageKey
    if (typeof pageKey === "string" && pageKey) {
        parts.push(`  Wiki 引用：[[${pageKey}|${evidence.title ?? pageKey}]]`)
    }
    parts.push(`  ${evidence.content.trim()}`)
    return parts.join("\n")
}

export function renderConversationSummary(summary: ConversationSummary): string {
    const blocks: string[] = []
    if (summary.goals.length) blocks.push(`目标：${summary.goals.join("；")}`)
    if (summary.decisions.length) blocks.push(`已达成决定：${summary.decisions.join("；")}`)
    if (summary.importantFacts.length) blocks.push(`关键事实：${summary.importantFacts.join("；")}`)
    if (summary.unresolvedQuestions.length) {
        blocks.push(`未解决问题：${summary.unresolvedQuestions.join("；")}`)
    }
    return blocks.join("\n")
}

/**
 * 从检索观察里收集带 pageKey 的 Wiki 候选（knowledge.search / knowledge.lookup 的 hits）。
 * 排除已经深读成证据的页面；同名 pageKey 只保留第一次出现的标题。
 */
function collectWikiPageTargets(
    observations: ObservationStore,
    evidence: AgentEvidence[],
): Array<{ pageKey: string; title: string }> {
    const citedKeys = new Set(
        evidence
            .map((item) => item.metadata?.pageKey)
            .filter((value): value is string => typeof value === "string" && value.length > 0),
    )
    const byKey = new Map<string, string>()
    for (const observation of observations.all) {
        if (observation.isError) continue
        const data = observation.data as { hits?: Array<{ pageKey?: unknown; title?: unknown }> } | undefined
        const hits = Array.isArray(data?.hits) ? data.hits : []
        for (const hit of hits) {
            const pageKey = typeof hit?.pageKey === "string" ? hit.pageKey.trim() : ""
            if (!pageKey || citedKeys.has(pageKey) || byKey.has(pageKey)) continue
            const title = typeof hit?.title === "string" && hit.title.trim() ? hit.title.trim() : pageKey
            byKey.set(pageKey, title)
        }
    }
    return [...byKey].map(([pageKey, title]) => ({ pageKey, title }))
}

/**
 * 最终回答前的收敛上下文（§102）。
 * 只带目标 + 证据 + 重要观察 + 计划完成情况 + 已知局限，不重塞原始工具结果。
 */
export function buildFinalAnswerContext(input: {
    state: AgentState
    evidence: AgentEvidence[]
    citationIndex?: (evidence: AgentEvidence) => number
    observations: ObservationStore
    limitations?: string[]
    wikiMode?: boolean
}): string {
    const sections: string[] = [`## 用户目标\n${input.state.goal}`]

    if (input.evidence.length > 0) {
        const citationRule = input.wikiMode
            ? `回答中引用 Wiki 页面证据时，必须在正文中内联写成 [[pageKey|页面标题]]（每条证据的「Wiki 引用」提示里有现成格式，照抄即可）；不要输出 [n] 数字角标。非Wiki 来源仍可用 [n] 标注。\n\n`
            : `回答中引用证据时使用 [n] 标注，n 为下面的编号。来自 Wiki 页面的证据（带「Wiki 引用」提示）改为内联引用：每条 Wiki 证据在其支撑的表述处写成 [[pageKey|页面标题]]，不同页面分别引用、不要只链其中一个；这类来源不必再标 [n]。\n\n`
        sections.push(
            `## 可引用证据\n`
            + citationRule
            + input.evidence.map((evidence, index) =>
                renderEvidence(evidence, input.citationIndex?.(evidence) ?? index + 1)).join("\n\n"),
        )
    } else {
        sections.push("## 可引用证据\n本轮没有获取到可引用的证据，请如实说明。")
    }

    // 检索命中但未深读的 Wiki 页面也列出来：正文提到这些主题时同样可以内联链接，
    // 否则收敛上下文只剩深读证据，模型想链别的页面也没有可照抄的 pageKey。
    const wikiTargets = collectWikiPageTargets(input.observations, input.evidence)
    if (wikiTargets.length > 0) {
        sections.push(
            `## 其他可引用的 Wiki 页面\n`
            + `以下是本轮检索命中、但没有深入阅读的 Wiki 页面。答案正文明确提到这些主题时，用 [[pageKey|标题]] 内联链接（格式已给全，严禁使用列表之外的 pageKey）：\n`
            + wikiTargets.map((target) => `- [[${target.pageKey}|${target.title}]]`).join("\n"),
        )
    }

    const errors = input.observations.all.filter((item) => item.isError)
    if (errors.length > 0) {
        sections.push(`## 执行中的问题\n${errors.map((item) => `- ${item.summary}`).join("\n")}`)
    }

    if (input.state.plan.length > 0) {
        sections.push(`## 计划完成情况\n${renderPlan(input.state.plan)}`)
    }

    const limitations = [...(input.limitations ?? []), ...input.state.openQuestions]
    if (limitations.length > 0) {
        sections.push(`## 已知局限\n${limitations.map((item) => `- ${item}`).join("\n")}`)
    }

    return sections.join("\n\n")
}
