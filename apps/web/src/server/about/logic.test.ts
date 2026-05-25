import { describe, expect, it } from "vitest"
import {
    DEFAULT_ABOUT_PROFILE,
    buildAboutProfileResponse,
    parseProfileListJson,
    serializeProfileList,
    validateAboutProfileInput,
} from "./logic"

describe("about profile logic", () => {
    it("在数据库无记录时返回默认关于我配置", () => {
        expect(buildAboutProfileResponse(null)).toEqual({
            ...DEFAULT_ABOUT_PROFILE,
            expertise: [...DEFAULT_ABOUT_PROFILE.expertise],
            toolkit: [...DEFAULT_ABOUT_PROFILE.toolkit],
            createdAt: null,
            updatedAt: null,
        })
    })

    it("解析数据库 JSON 列表时容错并回退默认值", () => {
        expect(parseProfileListJson("[\" AI \",\"\",\"Coding\",\"AI\"]", ["Fallback"])).toEqual(["AI", "Coding"])
        expect(parseProfileListJson("{bad", ["Fallback"])).toEqual(["Fallback"])
        expect(parseProfileListJson("{\"x\":1}", ["Fallback"])).toEqual(["Fallback"])
    })

    it("校验后台提交并过滤空行", () => {
        expect(validateAboutProfileInput({
            displayName: "  CiZai  ",
            roleTitle: " Creative Dev ",
            intro: " 第一段 \r\n\r\n 第二段 ",
            expertise: [" AI ", "", "Coding", "AI"],
            toolkit: "TypeScript\n\nReact\nTypeScript",
            quote: " Code is paint. ",
        })).toEqual({
            displayName: "CiZai",
            roleTitle: "Creative Dev",
            intro: "第一段\n\n第二段",
            expertise: ["AI", "Coding"],
            toolkit: ["TypeScript", "React"],
            quote: "Code is paint.",
        })
    })

    it("拒绝空值和超长列表", () => {
        expect(() => validateAboutProfileInput({ displayName: " ", roleTitle: "dev", intro: "intro", expertise: ["AI"], toolkit: ["TS"], quote: "q" }))
            .toThrow("名称不能为空")
        expect(() => validateAboutProfileInput({ displayName: "n", roleTitle: "dev", intro: "intro", expertise: [], toolkit: ["TS"], quote: "q" }))
            .toThrow("Expertise 不能为空")
        expect(() => validateAboutProfileInput({
            displayName: "n",
            roleTitle: "dev",
            intro: "intro",
            expertise: Array.from({ length: 21 }, (_, index) => `item-${index}`),
            toolkit: ["TS"],
            quote: "q",
        })).toThrow("Expertise 数量不能超过 20")
    })

    it("序列化列表前保持去空和去重", () => {
        expect(serializeProfileList([" React ", "", "AI", "React"])).toBe("[\"React\",\"AI\"]")
    })
})
