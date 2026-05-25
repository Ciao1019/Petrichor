// 业务规则与纯函数：参数校验、缓存命中判断、重生限频、视图序列化
import { badRequest } from "@/server/http/response"
import type { AiReviewRecord } from "@/server/db/schema"
import {
    REVIEW_PERIODS,
    type ReviewPeriod,
    buildPeriodKey,
    computePeriodBounds,
    isReviewPeriod,
    listRecentPeriodKeys,
    resolveDefaultPeriodKey,
} from "./period"
import type { ReviewStats } from "./stats"

export const MAX_REGENERATE_PER_DAY = 3
export const PERIOD_OPTION_COUNT = 12

export interface ReviewGetInput {
    period: ReviewPeriod
    periodKey: string
    forceRebuild: boolean
}

export interface ReviewListInput {
    period: ReviewPeriod | null
    pageNum: number
    pageSize: number
}

export interface ReviewRegenerateInput {
    period: ReviewPeriod
    periodKey: string
}

const PERIOD_OPTIONS_MAX_PAGE_SIZE = 50
const NARRATIVE_MAX_CHARS = 4000
const STATS_JSON_MAX_CHARS = 32_000

export function validateReviewGetInput(raw: unknown, now: Date): ReviewGetInput {
    const value = isRecord(raw) ? raw : {}
    const period = normalizeReviewPeriod(value.period)
    const periodKey = normalizePeriodKey(period, value.periodKey, now)
    return {
        period,
        periodKey,
        forceRebuild: Boolean(value.forceRebuild),
    }
}

export function validateReviewListInput(raw: unknown): ReviewListInput {
    const value = isRecord(raw) ? raw : {}
    const period = value.period == null || value.period === ""
        ? null
        : normalizeReviewPeriod(value.period)
    const pageNum = normalizePositiveInteger(value.pageNum, 1)
    const pageSize = Math.min(normalizePositiveInteger(value.pageSize, 20), PERIOD_OPTIONS_MAX_PAGE_SIZE)
    return { period, pageNum, pageSize }
}

export function validateReviewRegenerateInput(raw: unknown, now: Date): ReviewRegenerateInput {
    const value = isRecord(raw) ? raw : {}
    const period = normalizeReviewPeriod(value.period)
    const periodKey = normalizePeriodKey(period, value.periodKey, now)
    return { period, periodKey }
}

function normalizeReviewPeriod(value: unknown): ReviewPeriod {
    const upper = typeof value === "string" ? value.trim().toUpperCase() : ""
    if (!isReviewPeriod(upper)) {
        throw badRequest(`周期必须是 ${REVIEW_PERIODS.join(" / ")}`)
    }
    return upper
}

function normalizePeriodKey(period: ReviewPeriod, value: unknown, now: Date): string {
    const trimmed = typeof value === "string" ? value.trim() : ""
    if (!trimmed) {
        return resolveDefaultPeriodKey(period, now)
    }
    if (period === "MONTH" && !/^\d{4}-\d{2}$/.test(trimmed)) {
        throw badRequest("月份键格式应为 YYYY-MM")
    }
    if (period === "WEEK" && !/^\d{4}-W\d{2}$/.test(trimmed)) {
        throw badRequest("周次键格式应为 YYYY-WNN")
    }
    try {
        computePeriodBounds(period, trimmed)
    } catch {
        throw badRequest("周期键无效")
    }
    return trimmed
}

export function canRegenerateToday(input: {
    record: AiReviewRecord
    now: Date
}) {
    const { record, now } = input
    if (record.lastRegeneratedAt == null) {
        return true
    }
    const last = record.lastRegeneratedAt instanceof Date
        ? record.lastRegeneratedAt
        : new Date(record.lastRegeneratedAt)
    if (!isSameUtcDate(last, now)) {
        return true
    }
    return record.regenerateCount < MAX_REGENERATE_PER_DAY
}

export function nextRegenerateCounters(input: {
    record: AiReviewRecord | null
    now: Date
}) {
    const { record, now } = input
    if (!record || record.lastRegeneratedAt == null) {
        return { regenerateCount: 1, lastRegeneratedAt: now }
    }
    const last = record.lastRegeneratedAt instanceof Date
        ? record.lastRegeneratedAt
        : new Date(record.lastRegeneratedAt)
    const count = isSameUtcDate(last, now) ? record.regenerateCount + 1 : 1
    return { regenerateCount: count, lastRegeneratedAt: now }
}

export function ensureNarrativeLength(narrative: string) {
    if (narrative.length > NARRATIVE_MAX_CHARS) {
        throw badRequest("综述长度超出限制")
    }
}

export function ensureStatsJsonLength(statsJson: string) {
    if (statsJson.length > STATS_JSON_MAX_CHARS) {
        throw badRequest("统计数据超出存储上限")
    }
}

export interface ReviewView {
    id: string | null
    period: ReviewPeriod
    periodKey: string
    periodStart: string
    periodEnd: string
    stats: ReviewStats
    narrative: string
    generatedAt: string | null
    modelConfigId: string | null
    regenerateCount: number
    canRegenerate: boolean
    hasActivity: boolean
    fromCache: boolean
}

export function buildReviewView(input: {
    record: AiReviewRecord | null
    period: ReviewPeriod
    periodKey: string
    stats: ReviewStats
    narrative: string
    fromCache: boolean
    now: Date
}): ReviewView {
    const { record, period, periodKey, stats, narrative, fromCache, now } = input
    const bounds = computePeriodBounds(period, periodKey)
    return {
        id: record ? String(record.id) : null,
        period,
        periodKey,
        periodStart: bounds.start.toISOString(),
        periodEnd: bounds.end.toISOString(),
        stats,
        narrative,
        generatedAt: record ? toIsoString(record.generatedAt) : null,
        modelConfigId: record?.modelConfigId == null ? null : String(record.modelConfigId),
        regenerateCount: record?.regenerateCount ?? 0,
        canRegenerate: record ? canRegenerateToday({ record, now }) : true,
        hasActivity: stats.newArticles > 0 || stats.updatedArticles > 0,
        fromCache,
    }
}

export interface ReviewListItem {
    id: string
    period: ReviewPeriod
    periodKey: string
    periodStart: string
    periodEnd: string
    generatedAt: string
    statsSummary: {
        newArticles: number
        updatedArticles: number
        totalChars: number
    }
    narrativeExcerpt: string
}

export function buildReviewListItem(record: AiReviewRecord): ReviewListItem {
    const stats = parseStatsJsonSafe(record.statsJson)
    return {
        id: String(record.id),
        period: record.period as ReviewPeriod,
        periodKey: record.periodKey,
        periodStart: toIsoString(record.periodStart),
        periodEnd: toIsoString(record.periodEnd),
        generatedAt: toIsoString(record.generatedAt),
        statsSummary: {
            newArticles: Number(stats?.newArticles ?? 0),
            updatedArticles: Number(stats?.updatedArticles ?? 0),
            totalChars: Number(stats?.totalChars ?? 0),
        },
        narrativeExcerpt: buildExcerpt(record.narrative, 120),
    }
}

function parseStatsJsonSafe(value: string | null | undefined): Record<string, unknown> | null {
    if (!value) {
        return null
    }
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

function buildExcerpt(value: string, max: number) {
    const normalized = value.replace(/\s+/g, " ").trim()
    return normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized
}

export function buildPeriodOptions(period: ReviewPeriod, now: Date) {
    const keys = listRecentPeriodKeys(period, now, PERIOD_OPTION_COUNT)
    return keys.map((key) => ({
        key,
        label: formatPeriodLabel(period, key),
        isCurrent: key === buildPeriodKey(period, now),
        isDefault: key === resolveDefaultPeriodKey(period, now),
    }))
}

export function formatPeriodLabel(period: ReviewPeriod, key: string) {
    if (period === "MONTH") {
        const [year, month] = key.split("-")
        return `${year} 年 ${Number(month)} 月`
    }
    const match = /^(\d{4})-W(\d{2})$/.exec(key)
    if (!match) {
        return key
    }
    return `${match[1]} 年第 ${Number(match[2])} 周`
}

function isSameUtcDate(a: Date, b: Date) {
    return a.getUTCFullYear() === b.getUTCFullYear()
        && a.getUTCMonth() === b.getUTCMonth()
        && a.getUTCDate() === b.getUTCDate()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizePositiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function toIsoString(value: Date | string | null | undefined) {
    if (!value) {
        return ""
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
