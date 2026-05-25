// 聚合用户在指定周期内的写作活动数据，结果作为 AI 综述的输入与缓存
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm"
import type { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticleTags,
    knowledgeBaseArticles,
    knowledgeBases,
} from "@/server/db/schema"

type Database = ReturnType<typeof getDb>

export interface TopArticle {
    id: string
    title: string
    charCount: number
    isNew: boolean
    knowledgeBaseId: string | null
    knowledgeBaseName: string | null
    updatedAt: string
}

export interface TopTag {
    tag: string
    count: number
}

export interface KnowledgeBaseActivity {
    id: string
    name: string
    articleCount: number
}

export interface ReviewStats {
    newArticles: number
    updatedArticles: number
    totalChars: number
    knowledgeBaseCount: number
    topTags: TopTag[]
    topArticles: TopArticle[]
    knowledgeBases: KnowledgeBaseActivity[]
}

const TOP_ARTICLE_LIMIT = 5
const TOP_TAG_LIMIT = 8
const KB_ACTIVITY_LIMIT = 6

export async function aggregateReviewStats(input: {
    db: Database
    userId: number
    periodStart: Date
    periodEnd: Date
}): Promise<ReviewStats> {
    const { db, userId, periodStart, periodEnd } = input

    // 1) 期内新建：created_at 落入区间
    const newArticlesPromise = db
        .select({ total: count() })
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.userId, userId),
            gte(knowledgeBaseArticles.createdAt, periodStart),
            lt(knowledgeBaseArticles.createdAt, periodEnd),
        ))

    // 2) 期内被改动过的全部文章（新建也算改动），用于综合统计
    const touchedArticlesPromise = db
        .select({
            id: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            charCount: sql<number>`coalesce(char_length(${knowledgeBaseArticles.contentMd}), 0)`,
            createdAt: knowledgeBaseArticles.createdAt,
            updatedAt: knowledgeBaseArticles.updatedAt,
            knowledgeBaseId: knowledgeBaseArticles.knowledgeBaseId,
        })
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.userId, userId),
            gte(knowledgeBaseArticles.updatedAt, periodStart),
            lt(knowledgeBaseArticles.updatedAt, periodEnd),
        ))
        .orderBy(asc(knowledgeBaseArticles.updatedAt))

    const [newArticlesRow] = await newArticlesPromise
    const touchedArticles = await touchedArticlesPromise

    const newArticleCount = Number(newArticlesRow?.total ?? 0)
    const totalChars = touchedArticles.reduce((sum, row) => sum + (Number(row.charCount) || 0), 0)
    const touchedKbIds = Array.from(new Set(touchedArticles.map((row) => Number(row.knowledgeBaseId))))

    // 3) 知识库元数据
    const kbRows = touchedKbIds.length === 0
        ? []
        : await db
            .select({
                id: knowledgeBases.id,
                name: knowledgeBases.name,
            })
            .from(knowledgeBases)
            .where(and(eq(knowledgeBases.userId, userId), inArray(knowledgeBases.id, touchedKbIds)))

    const kbNameMap = new Map(kbRows.map((row) => [Number(row.id), row.name]))
    const kbCountMap = new Map<number, number>()
    for (const article of touchedArticles) {
        const kbId = Number(article.knowledgeBaseId)
        kbCountMap.set(kbId, (kbCountMap.get(kbId) ?? 0) + 1)
    }

    const knowledgeBaseActivities: KnowledgeBaseActivity[] = Array.from(kbCountMap.entries())
        .map(([id, articleCount]) => ({
            id: String(id),
            name: kbNameMap.get(id) ?? "未命名知识库",
            articleCount,
        }))
        .sort((a, b) => b.articleCount - a.articleCount)
        .slice(0, KB_ACTIVITY_LIMIT)

    // 4) Top 文章（按字数倒序）
    const newArticleIdSet = new Set(
        touchedArticles
            .filter((row) => row.createdAt && row.createdAt >= periodStart && row.createdAt < periodEnd)
            .map((row) => Number(row.id)),
    )
    const topArticles: TopArticle[] = [...touchedArticles]
        .sort((a, b) => (Number(b.charCount) || 0) - (Number(a.charCount) || 0))
        .slice(0, TOP_ARTICLE_LIMIT)
        .map((row) => {
            const id = Number(row.id)
            const kbId = Number(row.knowledgeBaseId)
            return {
                id: String(id),
                title: row.title,
                charCount: Number(row.charCount) || 0,
                isNew: newArticleIdSet.has(id),
                knowledgeBaseId: String(kbId),
                knowledgeBaseName: kbNameMap.get(kbId) ?? null,
                updatedAt: toIsoString(row.updatedAt),
            }
        })

    // 5) Top 标签
    const touchedArticleIds = touchedArticles.map((row) => Number(row.id))
    const tagRows = touchedArticleIds.length === 0
        ? []
        : await db
            .select({
                tag: knowledgeBaseArticleTags.tag,
                total: count(),
            })
            .from(knowledgeBaseArticleTags)
            .where(inArray(knowledgeBaseArticleTags.articleId, touchedArticleIds))
            .groupBy(knowledgeBaseArticleTags.tag)
            .orderBy(desc(count()))
            .limit(TOP_TAG_LIMIT)

    const topTags: TopTag[] = tagRows.map((row) => ({
        tag: row.tag,
        count: Number(row.total),
    }))

    return {
        newArticles: newArticleCount,
        updatedArticles: Math.max(0, touchedArticles.length - newArticleCount),
        totalChars,
        knowledgeBaseCount: knowledgeBaseActivities.length,
        topTags,
        topArticles,
        knowledgeBases: knowledgeBaseActivities,
    }
}

export function reviewStatsHasActivity(stats: ReviewStats) {
    return stats.newArticles > 0 || stats.updatedArticles > 0
}

function toIsoString(value: Date | string | null | undefined) {
    if (!value) {
        return new Date(0).toISOString()
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
