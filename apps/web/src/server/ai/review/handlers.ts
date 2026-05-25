import { and, count, desc, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { callChatCompletion } from "@/server/ai/generation"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import {
    aiReviews,
    knowledgeBaseArticles,
    notifications,
    type AiReviewRecord,
} from "@/server/db/schema"
import { inArray } from "drizzle-orm"
import { badRequest, ok, readJson, tableData, toErrorResponse } from "@/server/http/response"
import {
    MAX_REGENERATE_PER_DAY,
    buildPeriodOptions,
    buildReviewListItem,
    buildReviewView,
    canRegenerateToday,
    ensureNarrativeLength,
    ensureStatsJsonLength,
    formatPeriodLabel,
    nextRegenerateCounters,
    validateReviewGetInput,
    validateReviewListInput,
    validateReviewRegenerateInput,
    type ReviewView,
} from "./logic"
import {
    type ReviewPeriod,
    computePeriodBounds,
} from "./period"
import {
    type ArticleSnippet,
    buildReviewSystemPrompt,
    buildReviewUserMessage,
    normalizeReviewNarrative,
} from "./prompt"
import { aggregateReviewStats, type ReviewStats } from "./stats"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function getAiReview(request: NextRequest) {
    return withUser(request, async (user) => {
        const now = new Date()
        const input = validateReviewGetInput(await readJson(request), now)
        const db = getDb()

        const existing = await loadReviewRecord(db, user.id, input.period, input.periodKey)
        if (existing && !input.forceRebuild) {
            const view = buildReviewView({
                record: existing,
                period: input.period,
                periodKey: input.periodKey,
                stats: parseStatsJsonOrThrow(existing.statsJson),
                narrative: existing.narrative,
                fromCache: true,
                now,
            })
            return ok(view)
        }

        if (input.forceRebuild && existing && !canRegenerateToday({ record: existing, now })) {
            throw badRequest(`今日重新生成次数已达上限（最多 ${MAX_REGENERATE_PER_DAY} 次）`)
        }

        const view = await generateAndPersist({
            db,
            userId: user.id,
            period: input.period,
            periodKey: input.periodKey,
            existing,
            now,
        })
        return ok(view)
    })
}

export async function regenerateAiReview(request: NextRequest) {
    return withUser(request, async (user) => {
        const now = new Date()
        const input = validateReviewRegenerateInput(await readJson(request), now)
        const db = getDb()

        const existing = await loadReviewRecord(db, user.id, input.period, input.periodKey)
        if (existing && !canRegenerateToday({ record: existing, now })) {
            throw badRequest(`今日重新生成次数已达上限（最多 ${MAX_REGENERATE_PER_DAY} 次）`)
        }

        const view = await generateAndPersist({
            db,
            userId: user.id,
            period: input.period,
            periodKey: input.periodKey,
            existing,
            now,
        })
        return ok(view)
    })
}

export async function listAiReviews(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateReviewListInput(await readJson(request))
        const db = getDb()

        const filters = [eq(aiReviews.userId, user.id)]
        if (input.period) {
            filters.push(eq(aiReviews.period, input.period))
        }
        const where = and(...filters)

        const [totalRow] = await db
            .select({ total: count() })
            .from(aiReviews)
            .where(where)

        const rows = await db
            .select()
            .from(aiReviews)
            .where(where)
            .orderBy(desc(aiReviews.generatedAt), desc(aiReviews.id))
            .limit(input.pageSize)
            .offset((input.pageNum - 1) * input.pageSize)

        return tableData(rows.map(buildReviewListItem), totalRow?.total ?? 0)
    })
}

export async function getAiReviewPeriodOptions(request: NextRequest) {
    return withUser(request, async () => {
        const now = new Date()
        return ok({
            week: buildPeriodOptions("WEEK", now),
            month: buildPeriodOptions("MONTH", now),
        })
    })
}

async function loadReviewRecord(
    db: ReturnType<typeof getDb>,
    userId: number,
    period: ReviewPeriod,
    periodKey: string,
): Promise<AiReviewRecord | null> {
    const [row] = await db
        .select()
        .from(aiReviews)
        .where(and(
            eq(aiReviews.userId, userId),
            eq(aiReviews.period, period),
            eq(aiReviews.periodKey, periodKey),
        ))
        .limit(1)
    return row ?? null
}

async function generateAndPersist(input: {
    db: ReturnType<typeof getDb>
    userId: number
    period: ReviewPeriod
    periodKey: string
    existing: AiReviewRecord | null
    now: Date
}): Promise<ReviewView> {
    const { db, userId, period, periodKey, existing, now } = input
    const bounds = computePeriodBounds(period, periodKey)
    const stats = await aggregateReviewStats({
        db,
        userId,
        periodStart: bounds.start,
        periodEnd: bounds.end,
    })

    const isRegenerate = existing != null
    const counters = nextRegenerateCounters({ record: existing, now })

    let narrative: string
    let modelConfigId: number | null = null

    const hasActivity = stats.newArticles > 0 || stats.updatedArticles > 0
    if (!hasActivity) {
        narrative = period === "WEEK"
            ? `本周（${periodKey}）你没有新增或更新任何文章。如果只是暂时停下脚步，没关系；想找回节奏，可以从把最近的灵感先记成一条标题开始。`
            : `本月（${periodKey}）你没有新增或更新任何文章。把月初的一些零散想法落成草稿，也许就是下个周期的起点。`
    } else {
        const snippets = await collectArticleSnippets({ db, userId, stats })
        const userMessage = buildReviewUserMessage({
            period,
            periodKey,
            periodStartDisplay: formatBeijingDate(bounds.start),
            periodEndDisplay: formatBeijingDate(new Date(bounds.end.getTime() - 1)),
            stats,
            snippets,
        })
        const chatResult = await callChatCompletion({
            userId,
            systemPrompt: buildReviewSystemPrompt(),
            message: userMessage,
        })
        narrative = normalizeReviewNarrative(chatResult.answer)
        modelConfigId = chatResult.config?.id ?? null
    }

    ensureNarrativeLength(narrative)
    const statsJson = JSON.stringify(stats)
    ensureStatsJsonLength(statsJson)

    const persisted = await db.transaction(async (tx) => {
        if (existing) {
            const [updated] = await tx
                .update(aiReviews)
                .set({
                    statsJson,
                    narrative,
                    modelConfigId,
                    regenerateCount: counters.regenerateCount,
                    lastRegeneratedAt: counters.lastRegeneratedAt,
                    generatedAt: now,
                    updatedAt: now,
                    periodStart: bounds.start,
                    periodEnd: bounds.end,
                })
                .where(eq(aiReviews.id, existing.id))
                .returning()
            return updated
        }
        const [inserted] = await tx
            .insert(aiReviews)
            .values({
                userId,
                period,
                periodKey,
                periodStart: bounds.start,
                periodEnd: bounds.end,
                statsJson,
                narrative,
                modelConfigId,
                regenerateCount: 0,
                generatedAt: now,
            })
            .returning()
        return inserted
    })

    await insertReviewNotification({
        db,
        userId,
        review: persisted,
        period,
        periodKey,
        isRegenerate,
        hasActivity,
        now,
    })

    return buildReviewView({
        record: persisted,
        period,
        periodKey,
        stats,
        narrative,
        fromCache: false,
        now,
    })
}

async function collectArticleSnippets(input: {
    db: ReturnType<typeof getDb>
    userId: number
    stats: ReviewStats
}): Promise<ArticleSnippet[]> {
    const { db, userId, stats } = input
    const topIds = stats.topArticles.map((article) => Number(article.id)).filter(Number.isFinite)
    if (topIds.length === 0) {
        return []
    }
    const rows = await db
        .select({
            id: knowledgeBaseArticles.id,
            title: knowledgeBaseArticles.title,
            aiSummary: knowledgeBaseArticles.aiSummary,
        })
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.userId, userId),
            inArray(knowledgeBaseArticles.id, topIds),
        ))
    const summaryMap = new Map<number, string | null>(
        rows.map((row) => [Number(row.id), row.aiSummary]),
    )
    return stats.topArticles.map((article) => ({
        title: article.title,
        summary: summaryMap.get(Number(article.id)) ?? null,
        knowledgeBaseName: article.knowledgeBaseName,
        isNew: article.isNew,
        charCount: article.charCount,
    }))
}

async function insertReviewNotification(input: {
    db: ReturnType<typeof getDb>
    userId: number
    review: AiReviewRecord
    period: ReviewPeriod
    periodKey: string
    isRegenerate: boolean
    hasActivity: boolean
    now: Date
}) {
    const { db, userId, review, period, periodKey, isRegenerate, hasActivity, now } = input
    const label = formatPeriodLabel(period, periodKey)
    const title = isRegenerate
        ? `${label}回顾已重新生成`
        : `${label}回顾已生成`
    const content = hasActivity
        ? `已为你生成 ${label} 的 AI 写作回顾，点击查看详情。`
        : `${label}写作活动较少，回顾以简短的提示形式生成。`

    await db.insert(notifications).values({
        userId,
        category: "AI_REVIEW",
        bizType: "AI_REVIEW",
        bizId: review.id,
        title,
        content,
        payloadJson: JSON.stringify({
            reviewId: String(review.id),
            period,
            periodKey,
        }),
        createdAt: now,
        updatedAt: now,
    })
}

function parseStatsJsonOrThrow(value: string | null | undefined): ReviewStats {
    if (!value) {
        throw badRequest("缓存数据缺失")
    }
    try {
        return JSON.parse(value) as ReviewStats
    } catch {
        throw badRequest("缓存数据损坏")
    }
}

function formatBeijingDate(date: Date) {
    const shifted = new Date(date.getTime() + 480 * 60_000)
    const year = shifted.getUTCFullYear()
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
    const day = String(shifted.getUTCDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
}
