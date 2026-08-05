import { describe, expect, it } from "vitest"

import type { DashboardRhythmCell, DashboardTrendPoint } from "@/lib/api"
import {
    bucketRhythm,
    formatAxisTick,
    formatBytes,
    formatCompact,
    formatDuration,
    heatLevel,
    shiftRhythmToLocal,
    sliceTrend,
    sparkPath,
    statusMeta,
} from "./metrics-utils"

function cell(weekday: number, hour: number, count: number): DashboardRhythmCell {
    return { weekday, hour, count }
}

describe("formatCompact", () => {
    it("万以下按千分位展示", () => {
        expect(formatCompact(0)).toBe("0")
        expect(formatCompact(9999)).toBe("9,999")
    })

    it("万、亿按中文量级折算", () => {
        expect(formatCompact(12_345)).toBe("1.2万")
        expect(formatCompact(1_200_000)).toBe("120万")
        expect(formatCompact(123_456_789)).toBe("1.2亿")
    })

    it("负数保留符号", () => {
        expect(formatCompact(-12_345)).toBe("-1.2万")
    })
})

describe("formatAxisTick", () => {
    it("刻度不带小数，避免长文本被轴宽裁掉首字符", () => {
        // 曾经的 bug：18.0万 被裁成 8.0万，整条轴看起来不单调
        expect(formatAxisTick(180_000)).toBe("18万")
        expect(formatAxisTick(90_000)).toBe("9万")
        expect(formatAxisTick(270_000)).toBe("27万")
    })

    it("万以下保持原样，亿级折算", () => {
        expect(formatAxisTick(0)).toBe("0")
        expect(formatAxisTick(1200)).toBe("1,200")
        expect(formatAxisTick(230_000_000)).toBe("2亿")
    })

    it("整条刻度序列在文本上保持单调递增", () => {
        const ticks = [0, 90_000, 180_000, 270_000, 360_000].map(formatAxisTick)
        expect(ticks).toEqual(["0", "9万", "18万", "27万", "36万"])
        // 每个刻度都不超过 4 个字符，够窄轴显示
        expect(ticks.every((tick) => tick.length <= 4)).toBe(true)
    })
})

describe("formatBytes", () => {
    it("按 1024 进制换算并选择合适单位", () => {
        expect(formatBytes(0)).toBe("0 B")
        expect(formatBytes(512)).toBe("512 B")
        expect(formatBytes(1536)).toBe("1.5 KB")
        expect(formatBytes(86_400_000)).toBe("82.4 MB")
    })
})

describe("formatDuration", () => {
    it("毫秒与秒切换单位", () => {
        expect(formatDuration(0)).toBe("0 ms")
        expect(formatDuration(148)).toBe("148 ms")
        expect(formatDuration(2860)).toBe("2.86 s")
        expect(formatDuration(45_000)).toBe("45.0 s")
    })
})

describe("sliceTrend", () => {
    const trend: DashboardTrendPoint[] = Array.from({ length: 100 }, (_, index) => ({
        date: `2026-01-${String(index + 1).padStart(2, "0")}`,
        article: index,
        qa: 0,
        agent: 0,
        total: index,
    }))

    it("取尾部指定天数", () => {
        expect(sliceTrend(trend, 7)).toHaveLength(7)
        expect(sliceTrend(trend, 7)[6]?.article).toBe(99)
    })

    it("请求超过实际长度时返回全量而不是补空", () => {
        expect(sliceTrend(trend, 365)).toHaveLength(100)
    })
})

describe("shiftRhythmToLocal", () => {
    it("东八区把 UTC 周一 23 点推到周二 07 点", () => {
        const shifted = shiftRhythmToLocal([cell(1, 23, 5)], 480)
        expect(shifted.find((item) => item.weekday === 2 && item.hour === 7)?.count).toBe(5)
        expect(shifted.filter((item) => item.count > 0)).toHaveLength(1)
    })

    it("跨周边界回绕：UTC 周六 20 点在东八区落到周日 04 点", () => {
        const shifted = shiftRhythmToLocal([cell(6, 20, 3)], 480)
        expect(shifted.find((item) => item.weekday === 0 && item.hour === 4)?.count).toBe(3)
    })

    it("负偏移同样回绕：UTC 周日 02 点在西五区落到周六 21 点", () => {
        const shifted = shiftRhythmToLocal([cell(0, 2, 7)], -300)
        expect(shifted.find((item) => item.weekday === 6 && item.hour === 21)?.count).toBe(7)
    })

    it("半小时时区按分钟折算（+5:30 把 00 点推到 05 点）", () => {
        const shifted = shiftRhythmToLocal([cell(2, 0, 1)], 330)
        expect(shifted.find((item) => item.weekday === 2 && item.hour === 5)?.count).toBe(1)
    })

    it("平移不丢总量，且始终补齐 168 格", () => {
        const cells = [cell(0, 0, 1), cell(3, 12, 4), cell(6, 23, 2)]
        const shifted = shiftRhythmToLocal(cells, 480)
        expect(shifted).toHaveLength(168)
        expect(shifted.reduce((sum, item) => sum + item.count, 0)).toBe(7)
    })

    it("零偏移是恒等变换", () => {
        const shifted = shiftRhythmToLocal([cell(4, 9, 6)], 0)
        expect(shifted.find((item) => item.weekday === 4 && item.hour === 9)?.count).toBe(6)
    })
})

describe("bucketRhythm", () => {
    it("按 3 小时分桶，同桶内累加", () => {
        const bands = bucketRhythm([cell(1, 0, 2), cell(1, 1, 3), cell(1, 4, 1)], 3)
        expect(bands).toHaveLength(7 * 8)
        expect(bands.find((band) => band.weekday === 1 && band.band === 0)?.count).toBe(5)
        expect(bands.find((band) => band.weekday === 1 && band.band === 1)?.count).toBe(1)
    })

    it("桶边界标注正确，末桶收敛到 24", () => {
        const bands = bucketRhythm([], 3)
        const last = bands.find((band) => band.weekday === 0 && band.band === 7)
        expect(last?.startHour).toBe(21)
        expect(last?.endHour).toBe(24)
    })
})

describe("heatLevel", () => {
    it("0 恒为第 0 档", () => {
        expect(heatLevel(0, 10)).toBe(0)
        expect(heatLevel(5, 0)).toBe(0)
    })

    it("按占最大值比例分到 1-4 档", () => {
        expect(heatLevel(1, 10)).toBe(1)
        expect(heatLevel(4, 10)).toBe(2)
        expect(heatLevel(7, 10)).toBe(3)
        expect(heatLevel(10, 10)).toBe(4)
    })
})

describe("sparkPath", () => {
    it("空数组不产出路径", () => {
        expect(sparkPath([], 100, 20)).toBe("")
    })

    it("单点画一条水平线，避免除零", () => {
        expect(sparkPath([5], 100, 20)).toBe("M0 10 L100 10")
    })

    it("全等值时不出现 NaN", () => {
        const path = sparkPath([3, 3, 3], 100, 20)
        expect(path).not.toContain("NaN")
        expect(path.startsWith("M0")).toBe(true)
    })

    it("最大值贴顶、最小值贴底", () => {
        const path = sparkPath([0, 10], 100, 20)
        expect(path).toBe("M0.00 20.00 L100.00 0.00")
    })
})

describe("statusMeta", () => {
    it("已知状态映射到中文与状态色", () => {
        expect(statusMeta("ready").label).toBe("已完成")
        expect(statusMeta("failed").label).toBe("失败")
        expect(statusMeta("parsing").label).toBe("处理中")
    })

    it("未知状态原样透出，不伪装成正常状态", () => {
        expect(statusMeta("weird").label).toBe("weird")
    })
})
