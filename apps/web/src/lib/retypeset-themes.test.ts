import { describe, expect, it } from "vitest"
import {
    FIXED_RETYPESET_THEME,
    FIXED_RETYPESET_THEME_ID,
    normalizeAppearance,
} from "./retypeset-themes"

describe("Retypeset 主题配置", () => {
    it("固定使用 Sakura 樱粉主题", () => {
        expect(FIXED_RETYPESET_THEME_ID).toBe("sakura")
        expect(FIXED_RETYPESET_THEME.tone).toBe("light")
    })

    it("规范化外观配置时只保留前台问答开关", () => {
        expect(normalizeAppearance({
            publicQaEnabled: false,
        })).toEqual({
            publicQaEnabled: false,
        })
    })

    it("缺省前台问答开关时回退默认开启", () => {
        expect(normalizeAppearance({ publicQaEnabled: "yes" })).toEqual({
            publicQaEnabled: true,
        })
    })
})
