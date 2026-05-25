import { describe, expect, it } from "vitest"
import type { AiReviewRecord } from "@/server/db/schema"
import {
    MAX_REGENERATE_PER_DAY,
    buildPeriodOptions,
    buildReviewListItem,
    buildReviewView,
    canRegenerateToday,
    nextRegenerateCounters,
    validateReviewGetInput,
    validateReviewRegenerateInput,
} from "./logic"
import type { ReviewStats } from "./stats"

const baseRecord: AiReviewRecord = {
    id: 1,
    userId: 9,
    period: "WEEK",
    periodKey: "2026-W21",
    periodStart: new Date("2026-05-17T16:00:00Z"),
    periodEnd: new Date("2026-05-24T16:00:00Z"),
    statsJson: JSON.stringify({
        newArticles: 2,
        updatedArticles: 1,
        totalChars: 1200,
        knowledgeBaseCount: 1,
        topTags: [],
        topArticles: [],
        knowledgeBases: [],
    }),
    narrative: "本周你写了 2 篇新文章。",
    modelConfigId: 7,
    regenerateCount: 0,
    lastRegeneratedAt: null,
    generatedAt: new Date("2026-05-25T02:00:00Z"),
    createdAt: new Date("2026-05-25T02:00:00Z"),
    updatedAt: new Date("2026-05-25T02:00:00Z"),
}

const baseStats: ReviewStats = {
    newArticles: 2,
    updatedArticles: 1,
    totalChars: 1200,
    knowledgeBaseCount: 1,
    topTags: [],
    topArticles: [],
    knowledgeBases: [],
}

describe("validateReviewGetInput", () => {
    const now = new Date("2026-05-25T03:00:00Z")

    it("接受合法周期 + 自定义 key", () => {
        const result = validateReviewGetInput({ period: "WEEK", periodKey: "2026-W20" }, now)
        expect(result).toEqual({ period: "WEEK", periodKey: "2026-W20", forceRebuild: false })
    })

    it("不传 key 时退回默认上一周期", () => {
        const result = validateReviewGetInput({ period: "MONTH" }, now)
        expect(result.periodKey).toBe("2026-04")
    })

    it("拒绝非法周期", () => {
        expect(() => validateReviewGetInput({ period: "YEAR" }, now)).toThrow()
    })

    it("拒绝格式错误的 key", () => {
        expect(() => validateReviewGetInput({ period: "MONTH", periodKey: "2026/05" }, now)).toThrow()
        expect(() => validateReviewGetInput({ period: "WEEK", periodKey: "2026-99" }, now)).toThrow()
    })

    it("拒绝越界的 key", () => {
        expect(() => validateReviewGetInput({ period: "MONTH", periodKey: "2026-13" }, now)).toThrow()
    })

    it("regenerate 用同一套校验", () => {
        const result = validateReviewRegenerateInput({ period: "WEEK", periodKey: "2026-W21" }, now)
        expect(result.period).toBe("WEEK")
    })
})

describe("重生限频", () => {
    const today = new Date("2026-05-25T08:00:00Z")
    const yesterday = new Date("2026-05-24T08:00:00Z")

    it("无历史记录可以重生", () => {
        expect(canRegenerateToday({ record: { ...baseRecord, lastRegeneratedAt: null }, now: today })).toBe(true)
    })

    it("达到当日上限拒绝", () => {
        const record = { ...baseRecord, regenerateCount: MAX_REGENERATE_PER_DAY, lastRegeneratedAt: today }
        expect(canRegenerateToday({ record, now: today })).toBe(false)
    })

    it("跨日重置", () => {
        const record = { ...baseRecord, regenerateCount: MAX_REGENERATE_PER_DAY, lastRegeneratedAt: yesterday }
        expect(canRegenerateToday({ record, now: today })).toBe(true)
    })

    it("nextRegenerateCounters 累加 / 重置", () => {
        expect(nextRegenerateCounters({
            record: { ...baseRecord, regenerateCount: 2, lastRegeneratedAt: today },
            now: today,
        })).toEqual({ regenerateCount: 3, lastRegeneratedAt: today })

        expect(nextRegenerateCounters({
            record: { ...baseRecord, regenerateCount: 2, lastRegeneratedAt: yesterday },
            now: today,
        })).toEqual({ regenerateCount: 1, lastRegeneratedAt: today })

        expect(nextRegenerateCounters({ record: null, now: today }))
            .toEqual({ regenerateCount: 1, lastRegeneratedAt: today })
    })
})

describe("buildReviewView / buildReviewListItem", () => {
    const now = new Date("2026-05-25T03:00:00Z")

    it("缓存命中 view 携带正确的周期边界", () => {
        const view = buildReviewView({
            record: baseRecord,
            period: "WEEK",
            periodKey: "2026-W21",
            stats: baseStats,
            narrative: baseRecord.narrative,
            fromCache: true,
            now,
        })
        expect(view.fromCache).toBe(true)
        expect(view.hasActivity).toBe(true)
        expect(view.canRegenerate).toBe(true)
        expect(view.periodStart).toBe("2026-05-17T16:00:00.000Z")
    })

    it("无活动时 hasActivity 为 false", () => {
        const emptyStats = { ...baseStats, newArticles: 0, updatedArticles: 0 }
        const view = buildReviewView({
            record: null,
            period: "WEEK",
            periodKey: "2026-W22",
            stats: emptyStats,
            narrative: "本周没有写作活动。",
            fromCache: false,
            now,
        })
        expect(view.id).toBeNull()
        expect(view.hasActivity).toBe(false)
    })

    it("list item 抽取概要 + 截断综述", () => {
        const longNarrative = "啊".repeat(200)
        const item = buildReviewListItem({ ...baseRecord, narrative: longNarrative })
        expect(item.statsSummary.newArticles).toBe(2)
        expect(item.narrativeExcerpt.endsWith("…")).toBe(true)
    })
})

describe("buildPeriodOptions", () => {
    it("生成 12 个周次选项，默认/当前标记正确", () => {
        const now = new Date("2026-05-25T03:00:00Z")
        const week = buildPeriodOptions("WEEK", now)
        expect(week).toHaveLength(12)
        expect(week[0]).toMatchObject({ key: "2026-W22", isCurrent: true })
        expect(week.find((option) => option.isDefault)?.key).toBe("2026-W21")
    })
})
