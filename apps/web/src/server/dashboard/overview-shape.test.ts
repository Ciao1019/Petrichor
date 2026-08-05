import { describe, expect, it } from "vitest"

import {
    buildGrowth,
    buildKpiTile,
    buildRhythm,
    computeDelta,
    enumerateDays,
    sumRange,
    toCountMap,
} from "./overview-shape"

describe("enumerateDays", () => {
    it("从起始日按 UTC 连续枚举，跨月不断档", () => {
        const days = enumerateDays(new Date(Date.UTC(2026, 0, 30)), 4)
        expect(days).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"])
    })

    it("跨闰年 2 月正确推进", () => {
        const days = enumerateDays(new Date(Date.UTC(2028, 1, 28)), 3)
        expect(days).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"])
    })
})

describe("toCountMap", () => {
    it("丢弃 day 为空的行，并把字符串计数转成数字", () => {
        const map = toCountMap([
            { day: "2026-01-01", count: "3" },
            { day: null, count: 9 },
            { day: "2026-01-02", count: null },
        ])
        expect(map.get("2026-01-01")).toBe(3)
        expect(map.get("2026-01-02")).toBe(0)
        expect(map.has("")).toBe(false)
        expect(map.size).toBe(2)
    })
})

describe("computeDelta", () => {
    it("正常环比按百分比返回", () => {
        expect(computeDelta(12, 10)).toBeCloseTo(20)
        expect(computeDelta(8, 10)).toBeCloseTo(-20)
    })

    it("上一周期为 0 时返回 null 而不是 Infinity", () => {
        expect(computeDelta(5, 0)).toBeNull()
        expect(computeDelta(0, 0)).toBeNull()
    })
})

describe("buildKpiTile", () => {
    const days = enumerateDays(new Date(Date.UTC(2026, 0, 1)), 21)

    it("近 7 天与前 7 天分别取窗口，spark 取最后 14 天", () => {
        // 最后 7 天每天 2，前 7 天每天 1
        const map = new Map<string, number>()
        days.slice(-7).forEach((day) => map.set(day, 2))
        days.slice(-14, -7).forEach((day) => map.set(day, 1))

        const tile = buildKpiTile({ key: "articles", label: "文章", total: 99, map, days })

        expect(tile.value).toBe(99)
        expect(tile.current).toBe(14)
        expect(tile.previous).toBe(7)
        expect(tile.delta).toBeCloseTo(100)
        expect(tile.spark).toHaveLength(14)
        expect(tile.spark).toEqual([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2])
    })

    it("完全没有数据时不炸，delta 为 null", () => {
        const tile = buildKpiTile({
            key: "words",
            label: "字数",
            total: 0,
            map: new Map(),
            days,
        })
        expect(tile.current).toBe(0)
        expect(tile.previous).toBe(0)
        expect(tile.delta).toBeNull()
        expect(tile.spark.every((value) => value === 0)).toBe(true)
    })
})

describe("sumRange", () => {
    it("缺失的天按 0 计", () => {
        const map = new Map([["2026-01-02", 5]])
        expect(sumRange(map, ["2026-01-01", "2026-01-02", "2026-01-03"])).toBe(5)
    })
})

describe("buildGrowth", () => {
    it("窗口外的存量折成基线，每个月末都是真实累计值", () => {
        // 2026 年 1 月 31 天 + 2 月 28 天，正好两个整月
        const days = enumerateDays(new Date(Date.UTC(2026, 0, 1)), 59)
        const articleMap = new Map([
            ["2026-01-10", 2],
            ["2026-02-05", 3],
        ])
        const wordMap = new Map([
            ["2026-01-10", 2000],
            ["2026-02-05", 3000],
        ])

        const growth = buildGrowth({
            days,
            articleMap,
            wordMap,
            totalArticles: 15, // 窗口内 5 篇，说明窗口外还有 10 篇
            totalWords: 15_000,
            months: 12,
        })

        expect(growth).toEqual([
            { month: "2026-01", articles: 12, words: 12_000 },
            { month: "2026-02", articles: 15, words: 15_000 },
        ])
        // 最后一个月的累计必须等于总量
        expect(growth[growth.length - 1]?.articles).toBe(15)
    })

    it("只保留最近 N 个月", () => {
        const days = enumerateDays(new Date(Date.UTC(2025, 0, 1)), 365)
        const growth = buildGrowth({
            days,
            articleMap: new Map(),
            wordMap: new Map(),
            totalArticles: 0,
            totalWords: 0,
            months: 3,
        })
        expect(growth).toHaveLength(3)
    })

    it("总量小于窗口合计时基线夹到 0，不出现负累计", () => {
        const days = enumerateDays(new Date(Date.UTC(2026, 0, 1)), 31)
        const growth = buildGrowth({
            days,
            articleMap: new Map([["2026-01-05", 9]]),
            wordMap: new Map(),
            totalArticles: 2,
            totalWords: 0,
            months: 12,
        })
        expect(growth[0]?.articles).toBe(9)
        expect(growth.every((point) => point.articles >= 0)).toBe(true)
    })
})

describe("buildRhythm", () => {
    it("补齐 7×24 全量格子", () => {
        const cells = buildRhythm([{ weekday: 3, hour: 21, count: 4 }])
        expect(cells).toHaveLength(168)
        expect(cells.find((cell) => cell.weekday === 3 && cell.hour === 21)?.count).toBe(4)
        expect(cells.filter((cell) => cell.count > 0)).toHaveLength(1)
    })

    it("同一格子的多行结果累加", () => {
        const cells = buildRhythm([
            { weekday: "1", hour: "9", count: "2" },
            { weekday: 1, hour: 9, count: 3 },
        ])
        expect(cells.find((cell) => cell.weekday === 1 && cell.hour === 9)?.count).toBe(5)
        expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(5)
    })

    it("空值不会被 Number(null)=0 误算成周日 0 点", () => {
        const cells = buildRhythm([
            { weekday: null, hour: 9, count: 100 },
            { weekday: 2, hour: undefined, count: 50 },
            { weekday: "", hour: "", count: 20 },
        ])
        expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(0)
    })

    it("越界下标被丢弃，不会串到别的格子", () => {
        const cells = buildRhythm([
            { weekday: 7, hour: 0, count: 9 },
            { weekday: 0, hour: 24, count: 9 },
            { weekday: -1, hour: 3, count: 9 },
        ])
        expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(0)
    })
})
