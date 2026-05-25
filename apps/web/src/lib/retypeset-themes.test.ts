import { describe, expect, it } from "vitest"
import {
    normalizeAppearance,
    resolveRetypesetActiveTheme,
} from "./retypeset-themes"

describe("Retypeset 主题配置", () => {
    it("规范化非法外观配置时回退默认值", () => {
        expect(normalizeAppearance({
            dayTheme: "unknown",
            nightTheme: "forest",
            dayStartHour: -2,
            dayEndHour: 99,
            allowManualOverride: "yes",
        })).toEqual({
            dayTheme: "paper",
            nightTheme: "forest",
            dayStartHour: 0,
            dayEndHour: 24,
            allowManualOverride: true,
        })
    })

    it("允许手动覆盖时优先使用有效覆盖主题", () => {
        const appearance = normalizeAppearance({
            dayTheme: "matcha",
            nightTheme: "forest",
            dayStartHour: 6,
            dayEndHour: 18,
            allowManualOverride: true,
        })

        expect(resolveRetypesetActiveTheme(appearance, 9, "ocean")).toBe("ocean")
    })

    it("关闭手动覆盖时按时间选择数据库配置的主题", () => {
        const appearance = normalizeAppearance({
            dayTheme: "matcha",
            nightTheme: "forest",
            dayStartHour: 6,
            dayEndHour: 18,
            allowManualOverride: false,
        })

        expect(resolveRetypesetActiveTheme(appearance, 21, "ocean")).toBe("forest")
    })
})
