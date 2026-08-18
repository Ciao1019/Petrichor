import { callChatCompletion } from "@/server/ai/generation"
import { estimateTokens, type ConversationSummary } from "./context-manager"

/**
 * 长会话摘要（§23）。
 *
 * 目标不是"复述聊天记录"，而是维护四类跨轮有效的结构化信息：
 * 目标、已达成的决定、关键事实、未解决问题。
 *
 * 触发是有门槛的：短会话不摘要，避免为简单请求平白多一次 LLM 调用（§135）。
 * 摘要失败一律返回 null，主流程不受影响。
 */

export const SUMMARY_MIN_MESSAGES = 12
export const SUMMARY_MIN_TOKENS = 6_000

export type SummarizeInput = {
    userId: number
    messages: unknown[]
    /** 已有摘要，用于增量更新而不是每次重算 */
    previous?: ConversationSummary | null
    modelRefId?: number | null
    signal?: AbortSignal
}

/** 是否值得做摘要：轮次少或内容短就不做 */
export function shouldSummarize(messages: unknown[]): boolean {
    if (messages.length < SUMMARY_MIN_MESSAGES) return false
    return estimateTokens(renderTranscript(messages, messages.length)) >= SUMMARY_MIN_TOKENS
}

const SUMMARY_SYSTEM = `
你在维护一段长对话的结构化摘要，供后续轮次快速恢复上下文。

只输出 JSON，不要 Markdown 代码块，不要解释。形状：
{
  "goals": string[],
  "decisions": string[],
  "importantFacts": string[],
  "unresolvedQuestions": string[]
}

规则：
- goals：用户想达成什么，按重要性排序，最多 4 条。
- decisions：已经确定下来的选择或结论，最多 6 条。
- importantFacts：后续轮次还会用到的具体事实（数字、名称、路径、约束），最多 8 条。
- unresolvedQuestions：还没解决、后面要继续处理的问题，最多 5 条。
- 每条一句话，写具体内容，不要写"讨论了 X"这种空话。
- 只写对话里真实出现过的内容，不要推断、不要补全。
- 已有摘要仍然成立的条目要保留，不要每轮换一种说法。
`.trim()

export async function summarizeConversation(input: SummarizeInput): Promise<ConversationSummary | null> {
    if (!shouldSummarize(input.messages)) return null

    const previous = input.previous ? renderPrevious(input.previous) : ""
    const transcript = renderTranscript(input.messages, 40)

    try {
        const result = await callChatCompletion({
            userId: input.userId,
            purpose: "CHAT",
            modelRefId: input.modelRefId ?? null,
            systemPrompt: SUMMARY_SYSTEM,
            message: `${previous}对话记录：\n${transcript}`,
            ...(input.signal ? { signal: input.signal } : {}),
        })
        return parseSummary(result.answer)
    } catch {
        // 摘要是优化项，失败不能影响回答
        return null
    }
}

export function parseSummary(raw: string): ConversationSummary | null {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim()
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start < 0 || end <= start) return null

    let parsed: unknown
    try {
        parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== "object") return null

    const record = parsed as Record<string, unknown>
    const summary: ConversationSummary = {
        goals: toStringList(record.goals, 4),
        decisions: toStringList(record.decisions, 6),
        importantFacts: toStringList(record.importantFacts, 8),
        unresolvedQuestions: toStringList(record.unresolvedQuestions, 5),
    }
    const total = summary.goals.length + summary.decisions.length
        + summary.importantFacts.length + summary.unresolvedQuestions.length
    return total > 0 ? summary : null
}

function toStringList(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 300))
        .slice(0, max)
}

function renderPrevious(summary: ConversationSummary): string {
    return `已有摘要（沿用仍成立的条目）：\n${JSON.stringify(summary)}\n\n`
}

/** 把消息渲染成纯文本转录；只取最近 N 条，正文按条截断 */
export function renderTranscript(messages: unknown[], take: number): string {
    return messages
        .slice(-take)
        .map((message) => {
            const record = message as { role?: unknown; content?: unknown; parts?: unknown }
            const role = record.role === "user" ? "用户" : record.role === "assistant" ? "助手" : String(record.role ?? "")
            const text = extractText(record).slice(0, 800)
            return text ? `${role}：${text}` : ""
        })
        .filter(Boolean)
        .join("\n")
}

function extractText(message: { content?: unknown; parts?: unknown }): string {
    if (typeof message.content === "string") return message.content.trim()
    const parts = Array.isArray(message.parts)
        ? message.parts
        : Array.isArray(message.content)
            ? message.content
            : []
    return parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { type?: unknown; text?: unknown }
            return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
        })
        .filter(Boolean)
        .join("\n")
        .trim()
}
