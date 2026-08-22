import { buildAnswerQualityGuidance } from "./answer-quality"
import { buildFinalAnswerContext } from "./context-manager"
import type { EvidenceStore } from "./evidence"
import type { ObservationStore } from "./observation"
import { describeStopReasonForUser } from "./stop-policy"
import type { AgentEvidence, AgentState, AgentStopReason } from "./types"

/**
 * 最终回答阶段（§102/§103/§104）。
 *
 * 收敛上下文只带：用户目标 + 相关证据 + 重要观察 + 计划完成情况 + 已知局限。
 * 不重新塞入任何原始工具结果。
 */

export type FinalAnswerPlan = {
    /** 收敛后的 system instructions */
    instructions: string
    /** 参与引用编号的证据，顺序即 [1][2][3] */
    citedEvidence: AgentEvidence[]
}

export function buildFinalAnswerPlan(input: {
    state: AgentState
    evidence: EvidenceStore
    observations: ObservationStore
    stopReason?: AgentStopReason
    maxEvidence?: number
    /** Wiki 问答模式：引用格式从 [n] 角标切换为 [[pageKey|标题]] 内联 */
    wikiMode?: boolean
}): FinalAnswerPlan {
    const citedEvidence = input.evidence.topN(input.maxEvidence ?? 12)
    const limitations: string[] = []

    const stopNotice = describeStopReasonForUser(input.stopReason)
    if (stopNotice) {
        limitations.push(`${stopNotice}请基于已获取的信息作答，并说明尚未覆盖的部分。`)
    }
    if (citedEvidence.length === 0 && input.state.toolCallCount > 0) {
        limitations.push("本轮检索没有取得可引用的资料，请明确告知用户未找到相关内容。")
    }

    const conflicts = detectConflictHints(citedEvidence)
    if (conflicts.length > 0) {
        limitations.push(
            `以下证据可能存在冲突，请先指出冲突、比较来源与时间，再给结论：${conflicts.join("；")}`,
        )
    }

    const wikiMode = input.wikiMode === true
    const instructions = [
        wikiMode ? WIKI_FINAL_ANSWER_PROMPT : FINAL_ANSWER_PROMPT,
        `## 本题详略要求\n${buildAnswerQualityGuidance(input.state.goal)}`,
        buildFinalAnswerContext({
            state: input.state,
            evidence: citedEvidence,
            citationIndex: (item) => input.evidence.citationIndex(item.id),
            observations: input.observations,
            limitations,
            wikiMode,
        }),
    ].join("\n\n")

    return { instructions, citedEvidence }
}

export const FINAL_ANSWER_PROMPT = `
现在请基于已获取的信息给出最终回答。

要求：
- 直接回答用户的问题，不要复述执行过程，不要输出内部推理。
- 结论必须来自下面列出的证据；引用某条证据时在句末标注 [n]，n 是证据编号。
- 【Wiki 内联引用】凡有对应 Wiki 页面的内容都要内联引用：每条带「Wiki 引用」提示的证据，在其支撑的表述处写成 [[pageKey|页面标题]]；检索结果里带 pageKey 的其他 Wiki 页面，正文明确提及时也按此格式链接。不同页面分别引用，不要只给一个词加链接；同一页面多次提及只在首次加链接。pageKey 必须来自检索结果，严禁编造。这类来源不必再标 [n]。
- 内部知识库来源用标题与路径说明，外部来源说明站点与时间。
- 证据冲突时：先说明冲突点，再比较来源可信度与时间，最后给出结论并说明不确定性。
- 没有覆盖到的部分要明确说明，不要用常识补全内部实现细节。
- 默认追求完整、可用的回答，不要因为问题句子短就只答一句；只有用户明确要求简短时才压缩。
- 语言与用户保持一致，默认中文。
`.trim()

export const WIKI_FINAL_ANSWER_PROMPT = `
现在请基于已获取的 Wiki 信息给出最终回答。

要求：
- 直接回答用户的问题，不要复述执行过程，不要输出内部推理。
- 结论必须来自下面列出的证据。
- 【引用格式（最重要）】凡是来自 Wiki 页面的信息，必须在正文中内联写成 [[pageKey|页面标题]]，例如 [[concept-rag|RAG]]。pageKey 见每条证据的「Wiki 引用」提示。读者可以直接点击这些链接打开页面。
- 不要输出 [1]、[2] 这类数字角标；Wiki 页面来源一律使用 [[..]] 内联引用。同一页面多次提及时首次引用即可。
- 非Wiki 来源（网页等）仍可用 [n] 标注。
- 没有覆盖到的部分要明确说明，不要用常识补全内部实现细节。
- 默认追求完整、可用的回答；语言与用户保持一致，默认中文。
`.trim()

/**
 * 冲突线索检测（§104 第一版规则化）：
 * 同一主题下、内部与外部来源同时出现且含否定/版本差异词，提示模型重点核对。
 */
export function detectConflictHints(evidence: AgentEvidence[]): string[] {
    const internal = evidence.filter((item) => item.source === "knowledge" || item.source === "graph")
    const external = evidence.filter((item) => item.source === "web")
    if (internal.length === 0 || external.length === 0) return []

    const hints: string[] = []
    for (const inner of internal) {
        for (const outer of external) {
            if (!sharesTopic(inner, outer)) continue
            if (!hasContrastSignal(inner.content) && !hasContrastSignal(outer.content)) continue
            hints.push(`「${inner.title ?? "内部文档"}」与「${outer.title ?? "外部来源"}」`)
            break
        }
        if (hints.length >= 3) break
    }
    return hints
}

const CONTRAST_SIGNAL = /(不再|已废弃|deprecated|不推荐|改为|替换为|新版本|旧版本|however|instead|no longer)/i

function hasContrastSignal(content: string): boolean {
    return CONTRAST_SIGNAL.test(content)
}

/** 主题重合判定：标题关键词交集 */
function sharesTopic(a: AgentEvidence, b: AgentEvidence): boolean {
    const left = keywords(`${a.title ?? ""} ${a.content.slice(0, 200)}`)
    const right = keywords(`${b.title ?? ""} ${b.content.slice(0, 200)}`)
    let shared = 0
    for (const word of left) {
        if (right.has(word)) shared += 1
    }
    return shared >= 2
}

function keywords(text: string): Set<string> {
    const out = new Set<string>()
    for (const token of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) out.add(token)
    // 中文按 bigram 近似关键词
    for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
        for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
    }
    return out
}
