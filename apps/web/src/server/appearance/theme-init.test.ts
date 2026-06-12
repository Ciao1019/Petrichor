import { describe, expect, it } from "vitest"
import {
    FIXED_RETYPESET_THEME_ID,
    RETYPESET_THEME_ATTR,
} from "@/lib/retypeset-themes"
import { buildRetypesetThemeInitScript, resolveServerRetypesetTheme } from "./theme-init"

function runInitScript(script: string) {
    const attrs = new Map<string, string>()
    const fakeDocument = {
        documentElement: {
            setAttribute: (name: string, value: string) => {
                attrs.set(name, value)
            },
        },
    }

    new Function("document", script)(fakeDocument)

    return attrs
}

describe("Retypeset 首屏主题初始化脚本", () => {
    it("服务端固定返回 Sakura 樱粉", () => {
        expect(resolveServerRetypesetTheme()).toBe(FIXED_RETYPESET_THEME_ID)
    })

    it("首屏脚本固定应用 Sakura 樱粉", () => {
        const attrs = runInitScript(buildRetypesetThemeInitScript())

        expect(attrs.get(RETYPESET_THEME_ATTR)).toBe(FIXED_RETYPESET_THEME_ID)
    })
})
