import { describe, expect, it } from "vitest"
import {
    RETYPESET_INITIAL_APPEARANCE_GLOBAL,
    RETYPESET_THEME_ATTR,
    type RetypesetAppearanceConfig,
} from "@/lib/retypeset-themes"
import { buildRetypesetThemeInitScript, resolveServerRetypesetTheme } from "./theme-init"

function runInitScript(script: string, hour: number, storedTheme: string | null = null) {
    const attrs = new Map<string, string>()
    const fakeWindow = {
        localStorage: {
            getItem: () => storedTheme,
        },
    } as Record<string, unknown>
    const fakeDocument = {
        documentElement: {
            setAttribute: (name: string, value: string) => {
                attrs.set(name, value)
            },
        },
    }
    function FakeDate() {
        return { getHours: () => hour }
    }

    new Function("window", "document", "Date", script)(fakeWindow, fakeDocument, FakeDate)

    return {
        attrs,
        initialAppearance: fakeWindow[RETYPESET_INITIAL_APPEARANCE_GLOBAL],
    }
}

describe("Retypeset 首屏主题初始化脚本", () => {
    const appearance: RetypesetAppearanceConfig = {
        dayTheme: "matcha",
        nightTheme: "forest",
        dayStartHour: 6,
        dayEndHour: 18,
        allowManualOverride: true,
    }

    it("服务端兜底主题按数据库配置和服务端时间计算", () => {
        expect(resolveServerRetypesetTheme(appearance, new Date("2026-05-25T09:00:00"))).toBe("matcha")
        expect(resolveServerRetypesetTheme(appearance, new Date("2026-05-25T21:00:00"))).toBe("forest")
    })

    it("无手动覆盖时首屏脚本直接应用数据库配置的当前时段主题", () => {
        const result = runInitScript(buildRetypesetThemeInitScript(appearance), 9)

        expect(result.attrs.get(RETYPESET_THEME_ATTR)).toBe("matcha")
        expect(result.initialAppearance).toEqual(appearance)
    })

    it("允许手动覆盖时首屏脚本优先应用本地覆盖主题", () => {
        const result = runInitScript(buildRetypesetThemeInitScript(appearance), 9, "ocean")

        expect(result.attrs.get(RETYPESET_THEME_ATTR)).toBe("ocean")
    })

    it("关闭手动覆盖时首屏脚本忽略本地覆盖主题", () => {
        const result = runInitScript(buildRetypesetThemeInitScript({
            ...appearance,
            allowManualOverride: false,
        }), 21, "ocean")

        expect(result.attrs.get(RETYPESET_THEME_ATTR)).toBe("forest")
    })
})
