// AI 回顾的周期计算：所有周/月边界基于 Asia/Shanghai（UTC+8）口径，
// 返回值为 UTC 时间戳，可直接与 timestamptz 列比较。

export type ReviewPeriod = "WEEK" | "MONTH"

const BEIJING_OFFSET_MIN = 480
const MS_PER_MIN = 60_000
const MS_PER_DAY = 86_400_000

export const REVIEW_PERIODS: readonly ReviewPeriod[] = ["WEEK", "MONTH"] as const

export interface PeriodBounds {
    start: Date
    end: Date
}

export function isReviewPeriod(value: unknown): value is ReviewPeriod {
    return value === "WEEK" || value === "MONTH"
}

// 将 UTC Date 视为 Beijing 本地时间下的组件
function toBeijingParts(date: Date) {
    const shifted = new Date(date.getTime() + BEIJING_OFFSET_MIN * MS_PER_MIN)
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        weekday: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
    }
}

// 给定 Beijing 本地的 Y/M/D 00:00，返回对应 UTC Date
function fromBeijingDate(year: number, month: number, day: number) {
    return new Date(Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MIN * MS_PER_MIN)
}

// ISO 周：以周一为起点，第 1 周为包含 1 月 4 日的那一周
function computeIsoWeek(year: number, month: number, day: number) {
    const utcDate = Date.UTC(year, month - 1, day)
    const weekday = new Date(utcDate).getUTCDay() || 7
    // 跳到本周四，用于定位 ISO 周年
    const thursday = new Date(utcDate + (4 - weekday) * MS_PER_DAY)
    const isoYear = thursday.getUTCFullYear()
    const firstThursday = (() => {
        const jan4 = new Date(Date.UTC(isoYear, 0, 4))
        const jan4Weekday = jan4.getUTCDay() || 7
        return new Date(jan4.getTime() + (4 - jan4Weekday) * MS_PER_DAY)
    })()
    const isoWeek = Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY)) + 1
    return { isoYear, isoWeek }
}

export function buildPeriodKey(period: ReviewPeriod, date: Date): string {
    const parts = toBeijingParts(date)
    if (period === "MONTH") {
        return `${pad4(parts.year)}-${pad2(parts.month)}`
    }
    const { isoYear, isoWeek } = computeIsoWeek(parts.year, parts.month, parts.day)
    return `${pad4(isoYear)}-W${pad2(isoWeek)}`
}

export function computePeriodBounds(period: ReviewPeriod, key: string): PeriodBounds {
    if (period === "MONTH") {
        const match = /^(\d{4})-(\d{2})$/.exec(key)
        if (!match) {
            throw new Error(`无效的月份键：${key}`)
        }
        const year = Number(match[1])
        const month = Number(match[2])
        if (month < 1 || month > 12) {
            throw new Error(`无效的月份键：${key}`)
        }
        const start = fromBeijingDate(year, month, 1)
        const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
        const end = fromBeijingDate(nextMonth.y, nextMonth.m, 1)
        return { start, end }
    }

    const match = /^(\d{4})-W(\d{2})$/.exec(key)
    if (!match) {
        throw new Error(`无效的周次键：${key}`)
    }
    const isoYear = Number(match[1])
    const isoWeek = Number(match[2])
    if (isoWeek < 1 || isoWeek > 53) {
        throw new Error(`无效的周次键：${key}`)
    }
    // ISO 周一对应 1 月 4 日所在周的周一 + (isoWeek - 1) * 7 天
    const jan4 = new Date(Date.UTC(isoYear, 0, 4))
    const jan4Weekday = jan4.getUTCDay() || 7
    const isoWeek1MondayBeijing = jan4.getTime() - (jan4Weekday - 1) * MS_PER_DAY
    const mondayMs = isoWeek1MondayBeijing + (isoWeek - 1) * 7 * MS_PER_DAY
    // 此时 mondayMs 是 Beijing 本地周一 00:00 对应的"伪 UTC"，需要减去时区偏移得到真 UTC
    const start = new Date(mondayMs - BEIJING_OFFSET_MIN * MS_PER_MIN)
    const end = new Date(start.getTime() + 7 * MS_PER_DAY)
    return { start, end }
}

// 默认显示"上一个完整周期"——避免本周/本月只过了 1 天就生成空报告
export function resolveDefaultPeriodKey(period: ReviewPeriod, now: Date): string {
    if (period === "MONTH") {
        const parts = toBeijingParts(now)
        const { y, m } = parts.month === 1
            ? { y: parts.year - 1, m: 12 }
            : { y: parts.year, m: parts.month - 1 }
        return `${pad4(y)}-${pad2(m)}`
    }
    const previousWeek = new Date(now.getTime() - 7 * MS_PER_DAY)
    return buildPeriodKey("WEEK", previousWeek)
}

// 用于历史下拉：列出最近 N 个期次的 key（包含当前和上一个完整周期），按时间倒序
export function listRecentPeriodKeys(period: ReviewPeriod, now: Date, count: number): string[] {
    if (count <= 0) {
        return []
    }
    const keys: string[] = []
    if (period === "MONTH") {
        const parts = toBeijingParts(now)
        let y = parts.year
        let m = parts.month
        for (let i = 0; i < count; i++) {
            keys.push(`${pad4(y)}-${pad2(m)}`)
            if (m === 1) {
                y -= 1
                m = 12
            } else {
                m -= 1
            }
        }
        return keys
    }
    let cursor = now
    const seen = new Set<string>()
    while (keys.length < count) {
        const key = buildPeriodKey("WEEK", cursor)
        if (!seen.has(key)) {
            keys.push(key)
            seen.add(key)
        }
        cursor = new Date(cursor.getTime() - 7 * MS_PER_DAY)
    }
    return keys
}

function pad2(value: number) {
    return value.toString().padStart(2, "0")
}

function pad4(value: number) {
    return value.toString().padStart(4, "0")
}
