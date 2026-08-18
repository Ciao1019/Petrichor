import type { AgentEvidence } from "./types"

/**
 * 回答详略度不是任务复杂度："X 是什么"虽然只需一次检索，也不能默认退化成一句话。
 * 只有用户明确要求简短时才走 brief；其余问题默认给出完整、可用的解释。
 */
export type AnswerDepth = "brief" | "standard" | "detailed"

export type AnswerQualityResult = {
    adequate: boolean
    depth: AnswerDepth
    answerChars: number
    contentUnits: number
    evidenceChars: number
    reasons: string[]
}

const BRIEF_REQUEST = /(一句话|一两句|简短|简要|简单说|概括|只说结论|不要展开|tl\s*;?\s*dr)/i
const DETAILED_REQUEST = /(详细|详尽|全面|深入|展开|系统(地|性)?|逐项|完整介绍|具体说明|多讲|细说)/i
const CONCEPT_QUESTION = /(是什么|什么是|介绍(?:一下)?|是做什么的|有何作用|用途是什么|能做什么)/i

export function resolveAnswerDepth(goal: string): AnswerDepth {
    if (BRIEF_REQUEST.test(goal)) return "brief"
    if (DETAILED_REQUEST.test(goal)) return "detailed"
    return "standard"
}

/** 注入主 Agent 与强制收敛阶段的统一质量要求。 */
export function buildAnswerQualityGuidance(goal: string): string {
    const depth = resolveAnswerDepth(goal)
    if (depth === "brief") {
        return [
            "用户明确希望简短回答：先给结论，用 1～3 句话覆盖最关键的信息。",
            "不要为了凑长度展开；但仍需标注实际使用的证据。",
        ].join("\n")
    }

    const common = [
        "默认目标是完整、可用，而不是越短越好；不要只把多条证据压成一句定义。",
        "先直接给结论，再解释关键事实；证据覆盖不到的内容不要为了凑长度而编造。",
        "除非用户明确要求一句话，否则有充足证据时至少从多个信息点展开，并使用短段落或项目符号提高可读性。",
    ]

    if (depth === "detailed") {
        return [
            ...common,
            "用户希望详细说明：尽量覆盖背景/定位、核心能力或机制、典型使用方式、优势与限制、适用对象或注意事项。",
            "信息较多时使用小标题组织；每个结论都应能在证据中找到依据。",
        ].join("\n")
    }

    if (CONCEPT_QUESTION.test(goal)) {
        return [
            ...common,
            "这是概念/产品介绍类问题：在证据允许时，覆盖“它是什么、核心能力、怎么使用或适合谁、限制/注意事项”四类信息，而不只复述名称和一句定位。",
        ].join("\n")
    }

    return [
        ...common,
        "在证据允许时，至少覆盖结论、依据/原因、实际影响或下一步建议。",
    ].join("\n")
}

/**
 * 轻量质量门：只在已有较丰富 Evidence 时拦截明显草率的答案。
 * 它不评价文风，也不强迫弱证据场景灌水；失败后由最终回答阶段基于同一批证据重写。
 */
export function assessAnswerQuality(input: {
    goal: string
    answer: string
    evidence: AgentEvidence[]
}): AnswerQualityResult {
    const depth = resolveAnswerDepth(input.goal)
    const answerChars = visibleCharacterCount(input.answer)
    const contentUnits = countContentUnits(input.answer)
    const evidenceChars = input.evidence.reduce((total, item) => total + item.content.trim().length, 0)
    const reasons: string[] = []

    // 用户明确要求简短，或证据本身很少时，不用长度规则逼模型扩写。
    if (depth === "brief" || input.evidence.length === 0 || evidenceChars < 240) {
        return {
            adequate: answerChars > 0,
            depth,
            answerChars,
            contentUnits,
            evidenceChars,
            reasons: answerChars > 0 ? [] : ["回答为空"],
        }
    }

    const isConcept = CONCEPT_QUESTION.test(input.goal)
    const minChars = depth === "detailed"
        ? clamp(Math.round(evidenceChars * 0.14), 280, 520)
        : isConcept
            ? clamp(Math.round(evidenceChars * 0.1), 180, 320)
            : clamp(Math.round(evidenceChars * 0.08), 140, 260)
    const minUnits = depth === "detailed" ? 4 : isConcept ? 3 : 2

    if (answerChars < minChars) reasons.push(`正文仅 ${answerChars} 字，低于当前证据量对应的完整回答下限 ${minChars} 字`)
    if (contentUnits < minUnits) reasons.push(`只覆盖 ${contentUnits} 个信息点，至少应覆盖 ${minUnits} 个`)

    return {
        adequate: reasons.length === 0,
        depth,
        answerChars,
        contentUnits,
        evidenceChars,
        reasons,
    }
}

function visibleCharacterCount(text: string): number {
    return text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\[\d+\]/g, "")
        .replace(/[#>*_`~|-]/g, "")
        .replace(/\s+/g, "")
        .length
}

function countContentUnits(text: string): number {
    return text
        .split(/(?:\r?\n)+|[。！？!?；;]+/)
        .map((item) => item.replace(/^\s*(?:[-*+] |\d+[.)、]\s*)/, "").trim())
        .filter((item) => visibleCharacterCount(item) >= 8)
        .length
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}
