// 认知演化时间线（月报专属）：挑一个当期最活跃的主题，回看用户全部时间线上
// 对该主题的笔记，由模型归纳「理解是如何演化的」。素材不足或模型输出无效时
// 静默降级为 null，绝不阻塞月报生成。
import { and, asc, eq, inArray } from "drizzle-orm"
import type { getDb } from "@/server/db/client"
import { knowledgeBaseArticleTags, knowledgeBaseArticles } from "@/server/db/schema"
import type { ReviewEvolution, ReviewStats } from "./stats"

type Database = ReturnType<typeof getDb>

export const EVOLUTION_MIN_ARTICLES = 3
export const EVOLUTION_MIN_MONTHS = 2
const EVOLUTION_MAX_ARTICLES = 24
const SUMMARY_MAX_CHARS = 200
const MAX_ENTRIES = 8

export type EvolutionTopic =
    | { kind: "tag"; value: string }
    | { kind: "kb"; id: number; name: string }

export interface EvolutionArticleMaterial {
    title: string
    summary: string | null
    createdAt: Date
}

// 选题：优先取本期出现 >=2 次的高频标签，否则取本期最活跃（>=2 篇）的知识库
export function selectEvolutionTopic(stats: ReviewStats): EvolutionTopic | null {
    const topTag = stats.topTags.find((tag) => tag.count >= 2)
    if (topTag) {
        return { kind: "tag", value: topTag.tag }
    }
    const topKb = stats.knowledgeBases.find((kb) => kb.articleCount >= 2)
    if (topKb && Number.isFinite(Number(topKb.id))) {
        return { kind: "kb", id: Number(topKb.id), name: topKb.name }
    }
    return null
}

export function evolutionTopicLabel(topic: EvolutionTopic) {
    return topic.kind === "tag" ? topic.value : topic.name
}

// 素材足够讲「演化」的门槛：至少 3 篇笔记、跨至少 2 个自然月（北京时间）
export function hasEnoughEvolutionSpan(articles: EvolutionArticleMaterial[]) {
    if (articles.length < EVOLUTION_MIN_ARTICLES) return false
    const months = new Set(articles.map((article) => formatBeijingMonth(article.createdAt)))
    return months.size >= EVOLUTION_MIN_MONTHS
}

export async function gatherEvolutionMaterial(input: {
    db: Database
    userId: number
    topic: EvolutionTopic
}): Promise<EvolutionArticleMaterial[]> {
    const { db, userId, topic } = input

    if (topic.kind === "kb") {
        const rows = await db
            .select({
                title: knowledgeBaseArticles.title,
                summary: knowledgeBaseArticles.aiSummary,
                createdAt: knowledgeBaseArticles.createdAt,
            })
            .from(knowledgeBaseArticles)
            .where(and(
                eq(knowledgeBaseArticles.userId, userId),
                eq(knowledgeBaseArticles.knowledgeBaseId, topic.id),
            ))
            .orderBy(asc(knowledgeBaseArticles.createdAt))
            .limit(EVOLUTION_MAX_ARTICLES)
        return rows.map(toMaterial)
    }

    const tagRows = await db
        .select({ articleId: knowledgeBaseArticleTags.articleId })
        .from(knowledgeBaseArticleTags)
        .where(eq(knowledgeBaseArticleTags.tag, topic.value))
    const articleIds = tagRows.map((row) => Number(row.articleId)).filter(Number.isFinite)
    if (articleIds.length === 0) return []

    const rows = await db
        .select({
            title: knowledgeBaseArticles.title,
            summary: knowledgeBaseArticles.aiSummary,
            createdAt: knowledgeBaseArticles.createdAt,
        })
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.userId, userId),
            inArray(knowledgeBaseArticles.id, articleIds),
        ))
        .orderBy(asc(knowledgeBaseArticles.createdAt))
        .limit(EVOLUTION_MAX_ARTICLES)
    return rows.map(toMaterial)
}

export function buildEvolutionSystemPrompt() {
    return [
        "你是一名知识回顾助手，任务是根据用户围绕同一主题、按时间排列的笔记清单，归纳用户对该主题的认知是如何演化的。",
        "硬性规则：",
        "- 只输出一个 JSON 对象，不要输出任何其他文字或代码块标记。",
        '- 格式：{"topic":"主题名","synthesis":"...","entries":[{"period":"YYYY-MM","title":"阶段小标题","note":"..."}]}。',
        `- entries 按时间升序，3 到 ${MAX_ENTRIES} 条；把相邻且观点相近的笔记合并成一个阶段，不要逐篇罗列。`,
        "- 每条 note 用 1-2 句中文概括该阶段的核心认知或相对上一阶段的转变（承接、深化、修正、推翻都要点明），不超过 80 字。",
        "- synthesis 用 2-3 句中文总述整条演化轨迹（从什么认识出发，经历了什么转折，现在停在哪里）。",
        "- 只基于给出的标题与摘要归纳，不要虚构笔记中不存在的观点。",
        "- 素材看不出任何演化脉络时，输出 {\"topic\":\"\",\"synthesis\":\"\",\"entries\":[]}。",
    ].join("\n")
}

export function buildEvolutionUserMessage(input: {
    topicLabel: string
    articles: EvolutionArticleMaterial[]
}) {
    const lines: string[] = []
    lines.push(`主题：${input.topicLabel}`)
    lines.push(`以下是用户围绕该主题的 ${input.articles.length} 篇笔记，按写作时间升序：`)
    lines.push("")
    for (const article of input.articles) {
        const month = formatBeijingMonth(article.createdAt)
        const summary = article.summary?.trim()
            ? truncate(article.summary, SUMMARY_MAX_CHARS)
            : "（无摘要）"
        lines.push(`- [${month}] ${article.title}：${summary}`)
    }
    lines.push("")
    lines.push("请归纳这条认知演化时间线。")
    return lines.join("\n")
}

export function parseEvolutionResult(raw: string): ReviewEvolution | null {
    const jsonText = extractJsonObjectText(raw)
    let parsed: unknown
    try {
        parsed = JSON.parse(jsonText)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>

    const topic = typeof record.topic === "string" ? record.topic.trim() : ""
    const synthesis = typeof record.synthesis === "string" ? record.synthesis.trim() : ""
    const rawEntries = Array.isArray(record.entries) ? record.entries : []

    const entries = rawEntries
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null
            const entry = item as Record<string, unknown>
            const period = typeof entry.period === "string" ? entry.period.trim() : ""
            const title = typeof entry.title === "string" ? entry.title.trim() : ""
            const note = typeof entry.note === "string" ? entry.note.trim() : ""
            if (!/^\d{4}-\d{2}$/.test(period) || !note) return null
            return { period, title: title || period, note: truncate(note, 200) }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .slice(0, MAX_ENTRIES)

    if (!topic || !synthesis || entries.length < 2) return null
    return { topic, synthesis: truncate(synthesis, 600), entries }
}

function toMaterial(row: { title: string; summary: string | null; createdAt: Date | string }): EvolutionArticleMaterial {
    return {
        title: row.title,
        summary: row.summary,
        createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    }
}

export function formatBeijingMonth(date: Date) {
    const shifted = new Date(date.getTime() + 480 * 60_000)
    const year = shifted.getUTCFullYear()
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
    return `${year}-${month}`
}

function extractJsonObjectText(raw: string) {
    const stripped = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim()
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start >= 0 && end > start) {
        return stripped.slice(start, end + 1)
    }
    return stripped
}

function truncate(value: string, max: number) {
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized
}
