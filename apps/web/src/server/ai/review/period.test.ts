import { describe, expect, it } from "vitest"
import {
    buildPeriodKey,
    computePeriodBounds,
    listRecentPeriodKeys,
    resolveDefaultPeriodKey,
} from "./period"

// 所有断言以 Asia/Shanghai（UTC+8）口径为准

describe("buildPeriodKey", () => {
    it("根据 Beijing 时区将周一凌晨 0 点归入正确的 ISO 周", () => {
        // 2026-05-25 是周一，Beijing 00:00 = UTC 2026-05-24T16:00
        const beijingMonday00 = new Date("2026-05-24T16:00:00Z")
        expect(buildPeriodKey("WEEK", beijingMonday00)).toBe("2026-W22")
        // 2026-05-24 是周日 Beijing
        const beijingSundayLate = new Date("2026-05-24T15:00:00Z")
        expect(buildPeriodKey("WEEK", beijingSundayLate)).toBe("2026-W21")
    })

    it("月份键根据 Beijing 时区计算", () => {
        // UTC 2026-05-31T23:00 = Beijing 2026-06-01T07:00
        const date = new Date("2026-05-31T23:00:00Z")
        expect(buildPeriodKey("MONTH", date)).toBe("2026-06")
    })

    it("处理跨年 ISO 周（年末归入下一年第 1 周）", () => {
        // 2025-12-29 是周一，归入 2026-W01（因为 ISO 周年由所在周的周四决定）
        const date = new Date("2025-12-29T00:00:00Z")
        expect(buildPeriodKey("WEEK", date)).toBe("2026-W01")
    })
})

describe("computePeriodBounds", () => {
    it("周次的 start 是 Beijing 周一 00:00（UTC 周日 16:00）", () => {
        const { start, end } = computePeriodBounds("WEEK", "2026-W22")
        expect(start.toISOString()).toBe("2026-05-24T16:00:00.000Z")
        expect(end.toISOString()).toBe("2026-05-31T16:00:00.000Z")
    })

    it("月份的 start/end 与 Beijing 月初对齐", () => {
        const { start, end } = computePeriodBounds("MONTH", "2026-05")
        expect(start.toISOString()).toBe("2026-04-30T16:00:00.000Z")
        expect(end.toISOString()).toBe("2026-05-31T16:00:00.000Z")
    })

    it("跨年月份正常", () => {
        const { start, end } = computePeriodBounds("MONTH", "2026-12")
        expect(start.toISOString()).toBe("2026-11-30T16:00:00.000Z")
        expect(end.toISOString()).toBe("2026-12-31T16:00:00.000Z")
    })

    it("非法键抛错", () => {
        expect(() => computePeriodBounds("MONTH", "abc")).toThrow()
        expect(() => computePeriodBounds("MONTH", "2026-13")).toThrow()
        expect(() => computePeriodBounds("WEEK", "2026-W55")).toThrow()
    })
})

describe("resolveDefaultPeriodKey", () => {
    it("默认显示上一个完整周/月", () => {
        const now = new Date("2026-05-25T03:00:00Z") // Beijing 2026-05-25 11:00, ISO W22
        expect(resolveDefaultPeriodKey("WEEK", now)).toBe("2026-W21")
        expect(resolveDefaultPeriodKey("MONTH", now)).toBe("2026-04")
    })

    it("月初首月回退到去年 12 月", () => {
        const now = new Date("2026-01-05T03:00:00Z")
        expect(resolveDefaultPeriodKey("MONTH", now)).toBe("2025-12")
    })
})

describe("listRecentPeriodKeys", () => {
    it("返回近 N 个周/月的 key，包含当前期次，按倒序排列", () => {
        const now = new Date("2026-05-25T03:00:00Z")
        const weeks = listRecentPeriodKeys("WEEK", now, 3)
        expect(weeks).toEqual(["2026-W22", "2026-W21", "2026-W20"])

        const months = listRecentPeriodKeys("MONTH", now, 4)
        expect(months).toEqual(["2026-05", "2026-04", "2026-03", "2026-02"])
    })

    it("count 为 0 返回空", () => {
        expect(listRecentPeriodKeys("WEEK", new Date(), 0)).toEqual([])
    })
})
