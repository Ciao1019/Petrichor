import { badRequest } from "@/server/http/response"
import { buildHomepageArticleExcerpt, buildPublicArticleContentHash } from "@/server/kb/share-logic"

export interface ArticleSummaryGenerateInput {
    articleId: number
    forceRebuild: boolean
}

const articleSummaryMaxModelInputChars = 12000
const articleSummaryMaxChars = 420

export function validateArticleSummaryGenerateInput(raw: unknown): ArticleSummaryGenerateInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const articleId = String(value.articleId ?? "").trim()
    if (!articleId) {
        throw badRequest("文章ID不能为空")
    }
    if (!/^\d+$/.test(articleId)) {
        throw badRequest("文章ID非法")
    }

    return {
        articleId: Number(articleId),
        forceRebuild: Boolean(value.forceRebuild),
    }
}

export function buildArticleAiSummaryContentHash(contentMd: string) {
    return buildPublicArticleContentHash(contentMd)
}

export function buildArticleSummarySystemPrompt() {
    return [
        "你是一个严谨的文章摘要助手。",
        "请根据用户提供的文章标题与 Markdown 正文，生成一段中文摘要。",
        "规则：",
        "- 只输出摘要正文，不要输出标题、解释、项目符号、Markdown 或代码块。",
        "- 摘要控制在 80 到 180 个汉字左右，最多不超过 420 个字符。",
        "- 优先概括文章核心观点、关键结论和阅读价值。",
        "- 不要虚构文章中不存在的事实。",
        "- 如果正文信息很少，也要给出自然的一句话概括。",
    ].join("\n")
}

export function buildArticleSummaryUserMessage(input: {
    title: string
    contentMd: string
}) {
    const content = input.contentMd.length > articleSummaryMaxModelInputChars
        ? `${input.contentMd.slice(0, articleSummaryMaxModelInputChars)}\n\n[内容已截断]`
        : input.contentMd

    return [
        `文章标题：${input.title}`,
        "",
        "文章 Markdown 正文：",
        content,
    ].join("\n")
}

export function normalizeArticleSummaryModelOutput(raw: string) {
    const normalized = raw
        .trim()
        .replace(/^```(?:markdown|md|text)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^#{1,6}\s*摘要\s*/u, "")
        .replace(/^(文章)?(AI\s*)?摘要[:：]\s*/iu, "")
        .replace(/\s+/g, " ")
        .trim()

    if (!normalized) {
        throw badRequest("模型未返回有效摘要")
    }

    return normalized.length > articleSummaryMaxChars
        ? `${normalized.slice(0, articleSummaryMaxChars).trimEnd()}...`
        : normalized
}

export function isArticleAiSummaryCacheHit(input: {
    currentHash: string
    storedHash: string | null | undefined
    summary: string | null | undefined
}) {
    return Boolean(input.summary?.trim()) &&
        Boolean(input.storedHash?.trim()) &&
        input.storedHash === input.currentHash
}

export function resolveUsableArticleAiSummary(input: {
    summary: string | null | undefined
    summaryContentHash: string | null | undefined
    currentContentHash: string | null | undefined
}) {
    const summary = input.summary?.trim() ?? ""
    if (!summary) {
        return null
    }
    const summaryHash = input.summaryContentHash?.trim() ?? ""
    const currentHash = input.currentContentHash?.trim() ?? ""
    if (!summaryHash || !currentHash || summaryHash !== currentHash) {
        return null
    }
    return summary
}

export function resolveDisplayArticleAiSummary(input: {
    summary: string | null | undefined
}) {
    return input.summary?.trim() || null
}

export function buildArticleAiSummaryExcerpt(input: {
    summary: string | null | undefined
}, maxLength = 120) {
    const summary = resolveDisplayArticleAiSummary(input)
    return summary ? buildHomepageArticleExcerpt(summary, maxLength) : null
}
