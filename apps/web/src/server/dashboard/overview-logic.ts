import { and, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import {
    agentCallLogs,
    assistantRuns,
    assistantSteps,
    assistantThreads,
    docDocuments,
    knowledgeBaseArticleTags,
    knowledgeBaseArticles,
    knowledgeBaseImportJobs,
    knowledgeBaseWikiPages,
    knowledgeBases,
    siteGraphEdges,
    siteGraphNodes,
    users,
} from "@/server/db/schema"
import { listAssistantThreads, type toAssistantThreadResponse } from "@/server/assistant/thread-logic"
import {
    AGENT_WINDOW_DAYS,
    GROWTH_MONTHS,
    HEATMAP_DAYS,
    TREND_DAYS,
    addUtcDays,
    buildGrowth,
    buildKpiTile,
    buildRhythm,
    enumerateDays,
    formatUtcDay,
    startOfUtcDay,
    sumRange,
    toCountMap,
    type DashboardActivityItem,
    type DashboardHeatmapPoint,
    type DashboardOverview,
    type DashboardTrendPoint,
} from "./overview-shape"

export * from "./overview-shape"

/**
 * SQLite 只用于本地开发，时间戳以毫秒整数存储；PostgreSQL 存 timestamptz。
 * 下面这组表达式把两种方言的差异收敛在一处，避免每条聚合语句各写一遍。
 */
function dialect() {
    const sqlite = isSqliteDatabase()

    /** 按 UTC 日期分组的 YYYY-MM-DD */
    const day = (column: AnyPgColumn): SQL<string> =>
        sqlite
            ? sql<string>`strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`
            : sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`

    /** 星期几，0 = 周日（两种方言原生一致） */
    const weekday = (column: AnyPgColumn): SQL<number> =>
        sqlite
            ? sql<number>`cast(strftime('%w', ${column} / 1000, 'unixepoch') as integer)`
            : sql<number>`extract(dow from ${column} AT TIME ZONE 'UTC')::int`

    /** 小时，0-23，UTC */
    const hour = (column: AnyPgColumn): SQL<number> =>
        sqlite
            ? sql<number>`cast(strftime('%H', ${column} / 1000, 'unixepoch') as integer)`
            : sql<number>`extract(hour from ${column} AT TIME ZONE 'UTC')::int`

    const countAll = (): SQL<number> => (sqlite ? sql<number>`count(*)` : sql<number>`count(*)::int`)

    const countCol = (column: AnyPgColumn): SQL<number> =>
        sqlite ? sql<number>`count(${column})` : sql<number>`count(${column})::int`

    const countDistinct = (column: AnyPgColumn): SQL<number> =>
        sqlite
            ? sql<number>`count(distinct ${column})`
            : sql<number>`count(distinct ${column})::int`

    /** 求和并补零；PostgreSQL 下 sum() 返回 bigint/numeric，统一转成数值型 */
    const sumOf = (expression: SQL | AnyPgColumn): SQL<number> =>
        sqlite
            ? sql<number>`coalesce(sum(${expression}), 0)`
            : sql<number>`coalesce(sum(${expression}), 0)::bigint`

    /** 条件计数：sum(case when …) 两种方言写法一致 */
    const countWhen = (condition: SQL): SQL<number> =>
        sqlite
            ? sql<number>`sum(case when ${condition} then 1 else 0 end)`
            : sql<number>`sum(case when ${condition} then 1 else 0 end)::int`

    /** 平均值取整；空集合返回 0 而不是 null */
    const avgOf = (column: AnyPgColumn): SQL<number> =>
        sqlite
            ? sql<number>`cast(coalesce(avg(${column}), 0) as integer)`
            : sql<number>`coalesce(avg(${column}), 0)::int`

    const maxOf = (column: AnyPgColumn): SQL<number> =>
        sqlite
            ? sql<number>`coalesce(max(${column}), 0)`
            : sql<number>`coalesce(max(${column}), 0)::int`

    return { day, weekday, hour, countAll, countCol, countDistinct, sumOf, countWhen, avgOf, maxOf }
}

function num(value: unknown) {
    return Number(value) || 0
}

type AssistantThreadSummary = ReturnType<typeof toAssistantThreadResponse>

export async function loadDashboardOverview(
    userId: number,
): Promise<DashboardOverview<AssistantThreadSummary>> {
    const db = getDb()
    const now = new Date()
    const today = startOfUtcDay(now)
    const heatmapStart = addUtcDays(today, -(HEATMAP_DAYS - 1))
    const agentStart = addUtcDays(today, -(AGENT_WINDOW_DAYS - 1))
    const d = dialect()

    const articleDay = d.day(knowledgeBaseArticles.createdAt)
    const threadDay = d.day(assistantThreads.createdAt)
    const callDay = d.day(agentCallLogs.createdAt)
    const ownArticles = eq(knowledgeBaseArticles.userId, userId)
    const liveThreads = and(eq(assistantThreads.userId, userId), isNull(assistantThreads.deletedAt))

    // 这个页面对远端库要发很多条聚合，而单次往返的固定开销远大于每条语句自身的执行时间，
    // 所以能合并的都合并：标量总量塞进一条、同形状的分组结果用 union all 拼成一条。
    // 合并后往返次数从 21 降到 9，与改版前的旧版大屏持平，但指标多了两倍。
    const articleWords = d.sumOf(sql`length(${knowledgeBaseArticles.contentMd})`)
    const agentWindow = and(
        eq(agentCallLogs.userId, userId),
        gte(agentCallLogs.createdAt, agentStart),
    )

    const [
        scalarRow,
        dailyRows,
        distributionRows,
        groupRows,
        agentPathRows,
        toolRows,
        rhythmRows,
        recentArticleRows,
        recentThreadPage,
    ] = await Promise.all([
        // 所有标量总量：挂在当前用户那一行上，保证恰好返回一行
        db
            .select({
                articles: sql<number>`(select ${d.countAll()} from ${knowledgeBaseArticles} where ${ownArticles})`,
                words: sql<number>`(select ${articleWords} from ${knowledgeBaseArticles} where ${ownArticles})`,
                minutes: sql<number>`(select ${d.sumOf(sql`coalesce(${knowledgeBaseArticles.readingMinutes}, 0)`)} from ${knowledgeBaseArticles} where ${ownArticles})`,
                threads: sql<number>`(select ${d.countAll()} from ${assistantThreads} where ${liveThreads})`,
                knowledgeBases: sql<number>`(select ${d.countAll()} from ${knowledgeBases} where ${eq(knowledgeBases.userId, userId)})`,
                tags: sql<number>`(select ${d.countDistinct(knowledgeBaseArticleTags.tag)} from ${knowledgeBaseArticleTags} inner join ${knowledgeBaseArticles} on ${eq(knowledgeBaseArticleTags.articleId, knowledgeBaseArticles.id)} where ${ownArticles})`,
                wikiPages: sql<number>`(select ${d.countAll()} from ${knowledgeBaseWikiPages} where ${and(eq(knowledgeBaseWikiPages.userId, userId), isNull(knowledgeBaseWikiPages.archivedAt))})`,
                graphEdges: sql<number>`(select ${d.countAll()} from ${siteGraphEdges} where ${eq(siteGraphEdges.userId, userId)})`,
                agentCallsTotal: sql<number>`(select ${d.countAll()} from ${agentCallLogs} where ${eq(agentCallLogs.userId, userId)})`,
                // Agent 接口健康：窗口内的总量、成功、4xx、5xx、均值与峰值
                agentWindowTotal: sql<number>`(select ${d.countAll()} from ${agentCallLogs} where ${agentWindow})`,
                agentSuccess: sql<number>`(select ${d.countWhen(sql`${agentCallLogs.statusCode} < 400`)} from ${agentCallLogs} where ${agentWindow})`,
                agentClientErrors: sql<number>`(select ${d.countWhen(sql`${agentCallLogs.statusCode} >= 400 and ${agentCallLogs.statusCode} < 500`)} from ${agentCallLogs} where ${agentWindow})`,
                agentServerErrors: sql<number>`(select ${d.countWhen(sql`${agentCallLogs.statusCode} >= 500`)} from ${agentCallLogs} where ${agentWindow})`,
                agentAvgMs: sql<number>`(select ${d.avgOf(agentCallLogs.durationMs)} from ${agentCallLogs} where ${agentWindow})`,
                agentMaxMs: sql<number>`(select ${d.maxOf(agentCallLogs.durationMs)} from ${agentCallLogs} where ${agentWindow})`,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1),
        // 三条按天的活动序列：形状一致，用 bucket 区分后拼成一条
        // article 的 c2 是字数，agent 的 c2 是平均耗时、c3 是错误数
        db
            .select({
                bucket: sql<string>`t.bucket`,
                day: sql<string>`t.day`,
                c1: sql<number>`t.c1`,
                c2: sql<number>`t.c2`,
                c3: sql<number>`t.c3`,
            })
            .from(sql`(
                select 'article' as bucket, ${articleDay} as day, ${d.countAll()} as c1, ${articleWords} as c2, 0 as c3
                    from ${knowledgeBaseArticles}
                    where ${and(ownArticles, gte(knowledgeBaseArticles.createdAt, heatmapStart))}
                    group by ${articleDay}
                union all
                select 'qa', ${threadDay}, ${d.countAll()}, 0, 0
                    from ${assistantThreads}
                    where ${and(liveThreads, gte(assistantThreads.createdAt, heatmapStart))}
                    group by ${threadDay}
                union all
                select 'agent', ${callDay}, ${d.countAll()}, ${d.avgOf(agentCallLogs.durationMs)}, ${d.countWhen(sql`${agentCallLogs.statusCode} >= 400`)}
                    from ${agentCallLogs}
                    where ${and(eq(agentCallLogs.userId, userId), gte(agentCallLogs.createdAt, heatmapStart))}
                    group by ${callDay}
            ) as t`),
        // 知识库分布与标签分布：各自带 limit，所以先包一层子查询再 union
        db
            .select({
                bucket: sql<string>`t.bucket`,
                label: sql<string>`t.label`,
                c1: sql<number>`t.c1`,
            })
            .from(sql`(
                select * from (
                    select 'kb' as bucket, ${knowledgeBases.name} as label, ${d.countCol(knowledgeBaseArticles.id)} as c1
                        from ${knowledgeBaseArticles}
                        inner join ${knowledgeBases} on ${eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBases.id)}
                        where ${ownArticles}
                        group by ${knowledgeBases.id}, ${knowledgeBases.name}
                        order by c1 desc
                        limit 6
                ) as kb_dist
                union all
                select * from (
                    select 'tag' as bucket, ${knowledgeBaseArticleTags.tag} as label, ${d.countAll()} as c1
                        from ${knowledgeBaseArticleTags}
                        inner join ${knowledgeBaseArticles} on ${eq(knowledgeBaseArticleTags.articleId, knowledgeBaseArticles.id)}
                        where ${ownArticles}
                        group by ${knowledgeBaseArticleTags.tag}
                        order by c1 desc
                        limit 8
                ) as tag_dist
            ) as t`)
            // union all 本身不保证顺序，显式排序才能让前端拿到的就是 Top N 次序
            .orderBy(sql`t.bucket asc, t.c1 desc`),
        // 文档状态 / 导入任务状态 / 图谱节点类型：都是「按某列分组计数」，同样拼成一条
        db
            .select({
                bucket: sql<string>`t.bucket`,
                label: sql<string>`t.label`,
                c1: sql<number>`t.c1`,
                c2: sql<number>`t.c2`,
                c3: sql<number>`t.c3`,
            })
            .from(sql`(
                select 'doc' as bucket, ${docDocuments.status} as label, ${d.countAll()} as c1,
                       ${d.sumOf(sql`coalesce(${docDocuments.sizeBytes}, 0)`)} as c2,
                       ${d.sumOf(sql`coalesce(${docDocuments.pageCount}, 0)`)} as c3
                    from ${docDocuments}
                    where ${eq(docDocuments.userId, userId)}
                    group by ${docDocuments.status}
                union all
                select 'import', ${knowledgeBaseImportJobs.status}, ${d.countAll()}, 0, 0
                    from ${knowledgeBaseImportJobs}
                    where ${eq(knowledgeBaseImportJobs.userId, userId)}
                    group by ${knowledgeBaseImportJobs.status}
                union all
                select 'graph_node', ${siteGraphNodes.kind}, ${d.countAll()},
                       ${d.countWhen(sql`${siteGraphNodes.status} = 'PUBLISHED'`)}, 0
                    from ${siteGraphNodes}
                    where ${eq(siteGraphNodes.userId, userId)}
                    group by ${siteGraphNodes.kind}
            ) as t`)
            .orderBy(sql`t.bucket asc, t.c1 desc`),
        db
            .select({
                path: agentCallLogs.path,
                method: agentCallLogs.method,
                count: d.countAll(),
                avgMs: d.avgOf(agentCallLogs.durationMs),
                errorCount: d.countWhen(sql`${agentCallLogs.statusCode} >= 400`),
            })
            .from(agentCallLogs)
            .where(and(eq(agentCallLogs.userId, userId), gte(agentCallLogs.createdAt, agentStart)))
            .groupBy(agentCallLogs.path, agentCallLogs.method)
            .orderBy(desc(sql`count(*)`))
            .limit(6),
        // 助手工具调用：step 本身没有 user_id，经 run → thread 回溯归属
        db
            .select({
                name: assistantSteps.toolName,
                count: d.countAll(),
                okCount: d.countWhen(sql`${assistantSteps.status} = 'COMPLETED'`),
                avgMs: d.avgOf(assistantSteps.durationMs),
            })
            .from(assistantSteps)
            .innerJoin(assistantRuns, eq(assistantSteps.runId, assistantRuns.id))
            .innerJoin(assistantThreads, eq(assistantRuns.threadId, assistantThreads.id))
            .where(and(liveThreads, gte(assistantRuns.startedAt, agentStart)))
            .groupBy(assistantSteps.toolName)
            .orderBy(desc(sql`count(*)`))
            .limit(8),
        // 创作节律：按 UTC 的星期 × 小时统计，前端再折算到浏览器本地时区
        db
            .select({
                weekday: d.weekday(knowledgeBaseArticles.createdAt),
                hour: d.hour(knowledgeBaseArticles.createdAt),
                count: d.countAll(),
            })
            .from(knowledgeBaseArticles)
            .where(and(ownArticles, gte(knowledgeBaseArticles.createdAt, heatmapStart)))
            .groupBy(
                d.weekday(knowledgeBaseArticles.createdAt),
                d.hour(knowledgeBaseArticles.createdAt),
            ),
        db
            .select({
                id: knowledgeBaseArticles.id,
                title: knowledgeBaseArticles.title,
                knowledgeBaseId: knowledgeBaseArticles.knowledgeBaseId,
                knowledgeBaseName: knowledgeBases.name,
                createdAt: knowledgeBaseArticles.createdAt,
            })
            .from(knowledgeBaseArticles)
            .innerJoin(knowledgeBases, eq(knowledgeBaseArticles.knowledgeBaseId, knowledgeBases.id))
            .where(ownArticles)
            .orderBy(desc(knowledgeBaseArticles.createdAt), desc(knowledgeBaseArticles.id))
            .limit(6),
        listAssistantThreads({ userId, limit: 6 }),
    ])

    // 把合并回来的行按 bucket 拆开，还原成各自的序列
    const articleDaily = dailyRows.filter((row) => row.bucket === "article")
    const qaDaily = dailyRows.filter((row) => row.bucket === "qa")
    const agentDaily = dailyRows
        .filter((row) => row.bucket === "agent")
        .map((row) => ({ day: row.day, count: num(row.c1), avgMs: num(row.c2), errors: num(row.c3) }))

    const articleMap = toCountMap(articleDaily.map((row) => ({ day: row.day, count: row.c1 })))
    const wordMap = toCountMap(articleDaily.map((row) => ({ day: row.day, count: row.c2 })))
    const qaMap = toCountMap(qaDaily.map((row) => ({ day: row.day, count: row.c1 })))
    const agentMap = toCountMap(agentDaily)

    const days = enumerateDays(heatmapStart, HEATMAP_DAYS)

    let heatmapTotal = 0
    // 热力图只统计文章发布，语义与「创作足迹」一致
    const heatmapPoints: DashboardHeatmapPoint[] = days.map((date) => {
        const count = articleMap.get(date) ?? 0
        heatmapTotal += count
        return { date, count }
    })

    const trendDays = days.slice(-TREND_DAYS)
    const trend: DashboardTrendPoint[] = trendDays.map((date) => {
        const article = articleMap.get(date) ?? 0
        const qa = qaMap.get(date) ?? 0
        const agent = agentMap.get(date) ?? 0
        return { date, article, qa, agent, total: article + qa + agent }
    })

    const scalars = scalarRow[0]
    const totalArticles = num(scalars?.articles)
    const totalWords = num(scalars?.words)
    const totalMinutes = num(scalars?.minutes)
    const totalThreads = num(scalars?.threads)
    const totalKbs = num(scalars?.knowledgeBases)
    const totalTags = num(scalars?.tags)
    const totalWiki = num(scalars?.wikiPages)
    const totalAgentCalls = num(scalars?.agentCallsTotal)
    const graphEdgeTotal = num(scalars?.graphEdges)

    const docRows = groupRows.filter((row) => row.bucket === "doc")
    const importRows = groupRows.filter((row) => row.bucket === "import")
    const graphNodeRows = groupRows.filter((row) => row.bucket === "graph_node")

    const documentTotal = docRows.reduce((sum, row) => sum + num(row.c1), 0)
    const documentBytes = docRows.reduce((sum, row) => sum + num(row.c2), 0)
    const documentPages = docRows.reduce((sum, row) => sum + num(row.c3), 0)
    const importTotal = importRows.reduce((sum, row) => sum + num(row.c1), 0)
    const graphNodeTotal = graphNodeRows.reduce((sum, row) => sum + num(row.c1), 0)
    const graphNodePublished = graphNodeRows.reduce((sum, row) => sum + num(row.c2), 0)

    const agentWindowCalls = num(scalars?.agentWindowTotal)
    const agentSuccess = num(scalars?.agentSuccess)

    const recentActivity: DashboardActivityItem[] = [
        ...recentArticleRows.map((row) => ({
            kind: "article" as const,
            id: String(row.id),
            title: row.title,
            subtitle: row.knowledgeBaseName,
            at: new Date(row.createdAt).toISOString(),
        })),
        ...recentThreadPage.items.map((thread) => ({
            kind: "thread" as const,
            id: String(thread.id),
            title: thread.title || "未命名对话",
            subtitle: null,
            at: new Date(thread.updatedAt ?? thread.createdAt).toISOString(),
        })),
    ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 8)

    return {
        generatedAt: now.toISOString(),
        kpis: {
            primary: [
                buildKpiTile({ key: "articles", label: "文章总数", total: totalArticles, map: articleMap, days }),
                buildKpiTile({ key: "words", label: "累计字数", total: totalWords, map: wordMap, days, unit: "字" }),
                buildKpiTile({ key: "threads", label: "助手对话", total: totalThreads, map: qaMap, days }),
                buildKpiTile({ key: "agentCalls", label: "Agent 调用", total: totalAgentCalls, map: agentMap, days }),
            ],
            secondary: [
                { key: "knowledgeBases", label: "知识库", value: totalKbs },
                { key: "wikiPages", label: "Wiki 页面", value: totalWiki },
                { key: "documents", label: "文档", value: documentTotal, hint: `${documentPages} 页` },
                { key: "tags", label: "标签", value: totalTags },
                {
                    key: "graphNodes",
                    label: "图谱节点",
                    value: graphNodeTotal,
                    hint: `${graphNodePublished} 已发布`,
                },
                { key: "graphEdges", label: "图谱关系", value: graphEdgeTotal },
                { key: "readingMinutes", label: "阅读时长", value: totalMinutes, hint: "分钟" },
            ],
        },
        heatmap: {
            points: heatmapPoints,
            start: days[0] ?? formatUtcDay(heatmapStart),
            end: days[days.length - 1] ?? formatUtcDay(today),
            total: heatmapTotal,
        },
        trend,
        growth: buildGrowth({
            days,
            articleMap,
            wordMap,
            totalArticles,
            totalWords,
            months: GROWTH_MONTHS,
        }),
        rhythm: {
            cells: buildRhythm(rhythmRows),
            total: sumRange(articleMap, days),
        },
        distribution: {
            knowledgeBases: distributionRows
                .filter((row) => row.bucket === "kb")
                .map((row) => ({ label: row.label, count: num(row.c1) })),
            tags: distributionRows
                .filter((row) => row.bucket === "tag")
                .map((row) => ({ label: row.label, count: num(row.c1) })),
        },
        assets: [
            { label: "文章", count: totalArticles },
            { label: "Wiki 页面", count: totalWiki },
            { label: "文档", count: documentTotal },
            { label: "图谱节点", count: graphNodeTotal },
        ].filter((item) => item.count > 0),
        agent: {
            windowDays: AGENT_WINDOW_DAYS,
            totalCalls: agentWindowCalls,
            successCalls: agentSuccess,
            clientErrors: num(scalars?.agentClientErrors),
            serverErrors: num(scalars?.agentServerErrors),
            successRate: agentWindowCalls > 0 ? (agentSuccess / agentWindowCalls) * 100 : 0,
            avgDurationMs: num(scalars?.agentAvgMs),
            maxDurationMs: num(scalars?.agentMaxMs),
            topPaths: agentPathRows.map((row) => ({
                path: row.path,
                method: row.method,
                count: num(row.count),
                avgMs: num(row.avgMs),
                errorCount: num(row.errorCount),
            })),
            daily: days.slice(-AGENT_WINDOW_DAYS).map((date) => {
                const row = agentDaily.find((item) => item.day === date)
                return {
                    date,
                    count: num(row?.count),
                    avgMs: num(row?.avgMs),
                    errors: num(row?.errors),
                }
            }),
        },
        tools: {
            windowDays: AGENT_WINDOW_DAYS,
            items: toolRows.map((row) => ({
                name: row.name,
                count: num(row.count),
                okCount: num(row.okCount),
                avgMs: num(row.avgMs),
            })),
        },
        pipeline: {
            documents: docRows.map((row) => ({ status: row.label, count: num(row.c1) })),
            imports: importRows.map((row) => ({ status: row.label, count: num(row.c1) })),
            documentTotal,
            documentBytes,
            documentPages,
            importTotal,
        },
        recentActivity,
        recentThreads: recentThreadPage.items,
    }
}
