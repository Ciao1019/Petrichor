// AI 综述 prompt：基于聚合统计 + Top 文章标题/AI 摘要，不灌全文以控制 token
import type { ReviewPeriod } from "./period"
import type { ReviewStats } from "./stats"

export interface ArticleSnippet {
    title: string
    summary: string | null
    knowledgeBaseName: string | null
    isNew: boolean
    charCount: number
}

const NARRATIVE_MAX_INPUT_SNIPPETS = 8
const NARRATIVE_SNIPPET_MAX_CHARS = 220

export function buildReviewSystemPrompt() {
    return [
        "你是一名亲切而克制的中文知识回顾助手。",
        "你的任务是基于用户在某个周期内的写作活动数据，输出一段自然的回顾。",
        "硬性规则：",
        "- 直接输出回顾正文，不要使用 Markdown 标题、列表、代码块、表情符号。",
        "- 总字数控制在 220 到 360 个汉字。",
        "- 用第二人称（你）与用户对话，语气平实而具体，避免空泛的鼓励。",
        "- 如果数据中存在主题/标签倾向，自然地指出，避免堆砌名词。",
        "- 不要虚构未在数据中出现的标题、标签或事实。",
        "- 如果数据显示该周期几乎没有写作活动，要诚实承认，并给一句轻量的提醒，而不是夸大其辞。",
        "- 结尾可以用一句简短的展望或建议（不超过一句），但不要套话。",
    ].join("\n")
}

export function buildReviewUserMessage(input: {
    period: ReviewPeriod
    periodKey: string
    periodStartDisplay: string
    periodEndDisplay: string
    stats: ReviewStats
    snippets: ArticleSnippet[]
}) {
    const periodLabel = input.period === "WEEK" ? "本周" : "本月"
    const lines: string[] = []
    lines.push(`回顾周期：${input.period === "WEEK" ? "周报" : "月报"}（${input.periodKey}）`)
    lines.push(`时间范围：${input.periodStartDisplay} 至 ${input.periodEndDisplay}（北京时间）`)
    lines.push("")
    lines.push("核心统计：")
    lines.push(`- ${periodLabel}新增文章：${input.stats.newArticles} 篇`)
    lines.push(`- ${periodLabel}修改文章：${input.stats.updatedArticles} 篇`)
    lines.push(`- 涉及总字数：${input.stats.totalChars} 字`)
    lines.push(`- 活跃知识库数量：${input.stats.knowledgeBaseCount} 个`)

    if (input.stats.knowledgeBases.length > 0) {
        const kbDesc = input.stats.knowledgeBases
            .map((kb) => `${kb.name}（${kb.articleCount} 篇）`)
            .join("、")
        lines.push(`- 活跃知识库分布：${kbDesc}`)
    }

    if (input.stats.topTags.length > 0) {
        const tagDesc = input.stats.topTags
            .map((tag) => `${tag.tag}×${tag.count}`)
            .join("、")
        lines.push(`- 高频标签：${tagDesc}`)
    }

    const snippets = input.snippets.slice(0, NARRATIVE_MAX_INPUT_SNIPPETS)
    if (snippets.length > 0) {
        lines.push("")
        lines.push("代表性文章（仅供你理解主题倾向，请不要逐篇罗列标题）：")
        for (const snippet of snippets) {
            const tag = snippet.isNew ? "新建" : "更新"
            const kb = snippet.knowledgeBaseName ? `《${snippet.knowledgeBaseName}》/` : ""
            const summary = snippet.summary
                ? truncate(snippet.summary, NARRATIVE_SNIPPET_MAX_CHARS)
                : "（无摘要）"
            lines.push(`- [${tag}] ${kb}${snippet.title}（${snippet.charCount} 字）：${summary}`)
        }
    }

    lines.push("")
    lines.push("请基于以上数据生成一段自然的回顾正文。")
    return lines.join("\n")
}

export function normalizeReviewNarrative(raw: string) {
    const stripped = raw
        .trim()
        .replace(/^```(?:markdown|md|text)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^#{1,6}\s*回顾\s*/u, "")
        .replace(/^(本周|本月)?回顾[:：]\s*/u, "")
        .trim()
    if (!stripped) {
        throw new Error("模型未返回有效综述")
    }
    return stripped.length > 1200 ? `${stripped.slice(0, 1200).trimEnd()}...` : stripped
}

function truncate(value: string, max: number) {
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized
}
