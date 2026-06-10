import { describe, expect, it } from "vitest"
import { buildSiteAppearanceResponse, validateSiteAppearanceInput } from "./logic"

const baseInput = {
    dayTheme: "paper",
    nightTheme: "slate",
    dayStartHour: 6,
    dayEndHour: 18,
    allowManualOverride: true,
}

describe("站点外观配置：publicQaEnabled", () => {
    it("校验通过时透传 publicQaEnabled=false", () => {
        const result = validateSiteAppearanceInput({ ...baseInput, publicQaEnabled: false })
        expect(result.publicQaEnabled).toBe(false)
    })

    it("缺省 publicQaEnabled 时回退默认 true", () => {
        const result = validateSiteAppearanceInput(baseInput)
        expect(result.publicQaEnabled).toBe(true)
    })

    it("非布尔 publicQaEnabled 时回退默认 true", () => {
        const result = validateSiteAppearanceInput({ ...baseInput, publicQaEnabled: "yes" })
        expect(result.publicQaEnabled).toBe(true)
    })

    it("无记录时响应携带默认 publicQaEnabled=true", () => {
        expect(buildSiteAppearanceResponse(null).publicQaEnabled).toBe(true)
    })

    it("读取记录时反映存储的 publicQaEnabled", () => {
        const response = buildSiteAppearanceResponse({
            id: 1,
            dayTheme: "paper",
            nightTheme: "slate",
            dayStartHour: 6,
            dayEndHour: 18,
            allowManualOverride: true,
            publicQaEnabled: false,
            createdAt: new Date("2026-06-10T00:00:00Z"),
            updatedAt: new Date("2026-06-10T00:00:00Z"),
        })
        expect(response.publicQaEnabled).toBe(false)
    })
})
