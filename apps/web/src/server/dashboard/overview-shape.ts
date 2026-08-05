/**
 * 仪表盘大屏的纯数据整形逻辑。
 *
 * 这里只做「把数据库聚合结果拼成前端可直接渲染的结构」，不碰数据库，
 * 方便单测覆盖补零、环比、累计、节律折算这些容易算错的边界。
 */

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

export type DashboardGrowthPoint = {
    month: string
    articles: number
    words: number
}

/** 创作节律：UTC 的星期 × 小时计数，由前端按本地时区折算后再分桶 */
export type DashboardRhythmCell = {
    weekday: number
    hour: number
    count: number
}

export type DashboardDistributionItem = {
    label: string
    count: number
}

export type DashboardKpiTile = {
    key: string
    label: string
    /** 累计总量 */
    value: number
    /** 本周期（近 7 天）新增 */
    current: number
    /** 上一周期（前 7 天）新增 */
    previous: number
    /** 环比百分比；上一周期为 0 时无法计算，返回 null */
    delta: number | null
    /** 最近 14 天迷你走势 */
    spark: number[]
    unit?: string
}

export type DashboardStatItem = {
    key: string
    label: string
    value: number
    hint?: string
}

export type DashboardAgentPathStat = {
    path: string
    method: string
    count: number
    avgMs: number
    errorCount: number
}

export type DashboardAgentDailyPoint = {
    date: string
    count: number
    avgMs: number
    errors: number
}

export type DashboardToolStat = {
    name: string
    count: number
    okCount: number
    avgMs: number
}

export type DashboardStatusBucket = {
    status: string
    count: number
}

export type DashboardActivityItem = {
    kind: "article" | "thread"
    id: string
    title: string
    subtitle: string | null
    at: string
}

export const HEATMAP_DAYS = 365
export const TREND_DAYS = 365
export const GROWTH_MONTHS = 12
export const WINDOW_DAYS = 7
export const SPARK_DAYS = 14
/** Agent 接口健康与工具调用的统计窗口 */
export const AGENT_WINDOW_DAYS = 30

export function formatUtcDay(date: Date) {
    return date.toISOString().slice(0, 10)
}

export function startOfUtcDay(date: Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function addUtcDays(date: Date, days: number) {
    const next = new Date(date)
    next.setUTCDate(next.getUTCDate() + days)
    return next
}

export function enumerateDays(start: Date, days: number) {
    const result: string[] = []
    for (let i = 0; i < days; i += 1) {
        result.push(formatUtcDay(addUtcDays(start, i)))
    }
    return result
}

type DailyRow = { day: string | null; count: unknown }

/** 把「按天分组」的聚合结果转成 Map，缺失的天由调用方补零 */
export function toCountMap(rows: DailyRow[]) {
    const map = new Map<string, number>()
    for (const row of rows) {
        if (row.day) {
            map.set(row.day, Number(row.count) || 0)
        }
    }
    return map
}

export function sumRange(map: Map<string, number>, days: string[]) {
    return days.reduce((sum, day) => sum + (map.get(day) ?? 0), 0)
}

/**
 * 环比百分比。上一周期为 0 时不返回 Infinity——那种「涨了 ∞%」对读者没有信息量，
 * 统一用 null 表示「无可比基数」，由前端渲染成「新增」。
 */
export function computeDelta(current: number, previous: number): number | null {
    if (previous <= 0) return null
    return ((current - previous) / previous) * 100
}

export function buildKpiTile(input: {
    key: string
    label: string
    total: number
    map: Map<string, number>
    days: string[]
    unit?: string
}): DashboardKpiTile {
    const { days, map } = input
    const currentDays = days.slice(-WINDOW_DAYS)
    const previousDays = days.slice(-WINDOW_DAYS * 2, -WINDOW_DAYS)
    const current = sumRange(map, currentDays)
    const previous = sumRange(map, previousDays)
    return {
        key: input.key,
        label: input.label,
        value: input.total,
        current,
        previous,
        delta: computeDelta(current, previous),
        spark: days.slice(-SPARK_DAYS).map((day) => map.get(day) ?? 0),
        unit: input.unit,
    }
}

/**
 * 按月累计的内容增长。
 *
 * 窗口只有 365 天，更早的存量用「总量 − 窗口内合计」反推成基线，
 * 这样每个月末的累计值都是真实总量，而不是只统计了最近一年的假累计。
 */
export function buildGrowth(input: {
    days: string[]
    articleMap: Map<string, number>
    wordMap: Map<string, number>
    totalArticles: number
    totalWords: number
    months: number
}): DashboardGrowthPoint[] {
    const { days, articleMap, wordMap } = input
    const windowArticles = sumRange(articleMap, days)
    const windowWords = sumRange(wordMap, days)
    let articles = Math.max(0, input.totalArticles - windowArticles)
    let words = Math.max(0, input.totalWords - windowWords)

    const byMonth = new Map<string, { articles: number; words: number }>()
    const order: string[] = []
    for (const day of days) {
        const month = day.slice(0, 7)
        let bucket = byMonth.get(month)
        if (!bucket) {
            bucket = { articles: 0, words: 0 }
            byMonth.set(month, bucket)
            order.push(month)
        }
        bucket.articles += articleMap.get(day) ?? 0
        bucket.words += wordMap.get(day) ?? 0
    }

    const points: DashboardGrowthPoint[] = []
    for (const month of order) {
        const bucket = byMonth.get(month)
        articles += bucket?.articles ?? 0
        words += bucket?.words ?? 0
        points.push({ month, articles, words })
    }
    // 最早一个月往往只覆盖半个月，累计值本身仍然正确，只取最近 N 个月展示
    return points.slice(-input.months)
}

type RhythmRow = { weekday: unknown; hour: unknown; count: unknown }

/**
 * 严格解析分桶下标。
 *
 * 不能直接用 Number()：Number(null) 是 0 而不是 NaN，空值会被悄悄算成周日 0 点。
 */
function parseBucketIndex(value: unknown, max: number) {
    if (value === null || value === undefined || value === "") return null
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) return null
    return parsed
}

/** 补齐 7×24 全量格子，避免前端还要判空 */
export function buildRhythm(rows: RhythmRow[]): DashboardRhythmCell[] {
    const counts = new Map<string, number>()
    for (const row of rows) {
        const weekday = parseBucketIndex(row.weekday, 6)
        const hour = parseBucketIndex(row.hour, 23)
        if (weekday === null || hour === null) continue
        const key = `${weekday}:${hour}`
        counts.set(key, (counts.get(key) ?? 0) + (Number(row.count) || 0))
    }
    const cells: DashboardRhythmCell[] = []
    for (let weekday = 0; weekday < 7; weekday += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
            cells.push({ weekday, hour, count: counts.get(`${weekday}:${hour}`) ?? 0 })
        }
    }
    return cells
}

/** TThread 由调用方注入助手会话的响应类型，整形层本身不依赖数据库模块 */
export type DashboardOverview<TThread> = {
    generatedAt: string
    kpis: {
        primary: DashboardKpiTile[]
        secondary: DashboardStatItem[]
    }
    heatmap: {
        points: DashboardHeatmapPoint[]
        start: string
        end: string
        total: number
    }
    trend: DashboardTrendPoint[]
    growth: DashboardGrowthPoint[]
    rhythm: {
        cells: DashboardRhythmCell[]
        total: number
    }
    distribution: {
        knowledgeBases: DashboardDistributionItem[]
        tags: DashboardDistributionItem[]
    }
    assets: DashboardDistributionItem[]
    agent: {
        windowDays: number
        totalCalls: number
        successCalls: number
        clientErrors: number
        serverErrors: number
        successRate: number
        avgDurationMs: number
        maxDurationMs: number
        topPaths: DashboardAgentPathStat[]
        daily: DashboardAgentDailyPoint[]
    }
    tools: {
        windowDays: number
        items: DashboardToolStat[]
    }
    pipeline: {
        documents: DashboardStatusBucket[]
        imports: DashboardStatusBucket[]
        documentTotal: number
        documentBytes: number
        documentPages: number
        importTotal: number
    }
    recentActivity: DashboardActivityItem[]
    recentThreads: TThread[]
}
