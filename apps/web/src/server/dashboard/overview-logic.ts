import { and, desc, eq, gte, sql } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import {
    agentCallLogs,
    knowledgeBaseAgentThreads,
    knowledgeBaseArticleTags,
    knowledgeBaseArticles,
    knowledgeBases,
} from "@/server/db/schema"
import { listAllAgentThreads, toAgentThreadResponse } from "@/server/kb/wiki-agent-logic"

const HEATMAP_DAYS = 365
const TREND_DAYS = 30
const ACTIVITY_WINDOW_DAYS = 7

export type DashboardActivityKind = "article" | "qa" | "agent"

export type DashboardHeatmapPoint = {
    date: string
    count: number
}

export type DashboardTrendPoint = {
    date: string
    article: number
    qa: number
    agent: number
    total: number
}

export type DashboardDistributionItem = {
    label: string
    count: number
}

export type DashboardOverview = {
    kpis: {
        articles: number
        qaThreads: number
        knowledgeBases: number
        activity7d: number
    }
    heatmap: {
        points: DashboardHeatmapPoint[]
        start: string
        end: string
        total: number
    }
    trend: DashboardTrendPoint[]
    distribution: {
        knowledgeBases: DashboardDistributionItem[]
        tags: DashboardDistributionItem[]
    }
    recentThreads: ReturnType<typeof toAgentThreadResponse>[]
}

function formatUtcDay(date: Date) {
    return date.toISOString().slice(0, 10)
}

function startOfUtcDay(date: Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number) {
    const next = new Date(date)
    next.setUTCDate(next.getUTCDate() + days)
    return next
}

function enumerateDays(start: Date, days: number) {
    const result: string[] = []
    for (let i = 0; i < days; i += 1) {
        result.push(formatUtcDay(addUtcDays(start, i)))
    }
    return result
}

type DailyRow = { day: string; count: number }

function toCountMap(rows: DailyRow[]) {
    const map = new Map<string, number>()
    for (const row of rows) {
        if (row.day) {
            map.set(row.day, Number(row.count) || 0)
        }
    }
    return map
}

export async function loadDashboardOverview(userId: number): Promise<DashboardOverview> {
    const db = getDb()
    const today = startOfUtcDay(new Date())
    const heatmapStart = addUtcDays(today, -(HEATMAP_DAYS - 1))
    const trendStart = addUtcDays(today, -(TREND_DAYS - 1))

    const articleDay = sql<string>`to_char(${knowledgeBaseArticles.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
    const threadDay = sql<string>`to_char(${knowledgeBaseAgentThreads.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
    const callDay = sql<string>`to_char(${agentCallLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`

    const [
        articleDaily,
        qaDaily,
        agentDaily,
        articleTotalRows,
        qaTotalRows,
        kbTotalRows,
        kbDistributionRows,
        tagDistributionRows,
        recent,
    ] = await Promise.all([
        db
            .select({ day: articleDay, count: sql<number>`count(*)::int` })
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.userId, userId), gte(knowledgeBaseArticles.createdAt, heatmapStart)))
            .groupBy(articleDay),
        db
            .select({ day: threadDay, count: sql<number>`count(*)::int` })
            .from(knowledgeBaseAgentThreads)
            .where(and(eq(knowledgeBaseAgentThreads.userId, userId), gte(knowledgeBaseAgentThreads.createdAt, heatmapStart)))
            .groupBy(threadDay),
        db
            .select({ day: callDay, count: sql<number>`count(*)::int` })
            .from(agentCallLogs)
            .where(and(eq(agentCallLogs.userId, userId), gte(agentCallLogs.createdAt, heatmapStart)))
            .groupBy(callDay),
        db
            .select({ value: sql<number>`count(*)::int` })
            .from(knowledgeBaseArticles)
            .where(eq(knowledgeBaseArticles.userId, userId)),
        db
            .select({ value: sql<number>`count(*)::int` })
            .from(knowledgeBaseAgentThreads)
            .where(eq(knowledgeBaseAgentThreads.userId, userId)),
        db
            .select({ value: sql<number>`count(*)::int` })
            .from(knowledgeBases)
            .where(eq(knowledgeBases.userId, userId)),
        db
            .select({
                label: knowledgeBases.name,
                count: sql<number>`count(${knowledgeBaseArticles.id})::int`,
            })
            .from(knowledgeBaseArticles)
            .innerJoin(knowledgeBases, eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBases.id))
            .where(eq(knowledgeBaseArticles.userId, userId))
            .groupBy(knowledgeBases.id, knowledgeBases.name)
            .orderBy(desc(sql`count(${knowledgeBaseArticles.id})`))
            .limit(6),
        db
            .select({
                label: knowledgeBaseArticleTags.tag,
                count: sql<number>`count(*)::int`,
            })
            .from(knowledgeBaseArticleTags)
            .innerJoin(knowledgeBaseArticles, eq(knowledgeBaseArticleTags.articleId, knowledgeBaseArticles.id))
            .where(eq(knowledgeBaseArticles.userId, userId))
            .groupBy(knowledgeBaseArticleTags.tag)
            .orderBy(desc(sql`count(*)`))
            .limit(8),
        listAllAgentThreads(userId, { limit: 6 }),
    ])

    const articleMap = toCountMap(articleDaily)
    const qaMap = toCountMap(qaDaily)
    const agentMap = toCountMap(agentDaily)

    const heatmapDays = enumerateDays(heatmapStart, HEATMAP_DAYS)
    let heatmapTotal = 0
    // 热力图只统计文章发布活动
    const heatmapPoints: DashboardHeatmapPoint[] = heatmapDays.map((date) => {
        const count = articleMap.get(date) ?? 0
        heatmapTotal += count
        return { date, count }
    })

    const trendDays = enumerateDays(trendStart, TREND_DAYS)
    const trend: DashboardTrendPoint[] = trendDays.map((date) => {
        const article = articleMap.get(date) ?? 0
        const qa = qaMap.get(date) ?? 0
        const agent = agentMap.get(date) ?? 0
        return { date, article, qa, agent, total: article + qa + agent }
    })

    const activityWindow = enumerateDays(addUtcDays(today, -(ACTIVITY_WINDOW_DAYS - 1)), ACTIVITY_WINDOW_DAYS)
    const activity7d = activityWindow.reduce((sum, date) => {
        return sum + (articleMap.get(date) ?? 0) + (qaMap.get(date) ?? 0) + (agentMap.get(date) ?? 0)
    }, 0)

    return {
        kpis: {
            articles: Number(articleTotalRows[0]?.value ?? 0),
            qaThreads: Number(qaTotalRows[0]?.value ?? 0),
            knowledgeBases: Number(kbTotalRows[0]?.value ?? 0),
            activity7d,
        },
        heatmap: {
            points: heatmapPoints,
            start: heatmapDays[0] ?? formatUtcDay(heatmapStart),
            end: heatmapDays[heatmapDays.length - 1] ?? formatUtcDay(today),
            total: heatmapTotal,
        },
        trend,
        distribution: {
            knowledgeBases: kbDistributionRows.map((row) => ({
                label: row.label,
                count: Number(row.count) || 0,
            })),
            tags: tagDistributionRows.map((row) => ({
                label: row.label,
                count: Number(row.count) || 0,
            })),
        },
        recentThreads: recent.threads,
    }
}
