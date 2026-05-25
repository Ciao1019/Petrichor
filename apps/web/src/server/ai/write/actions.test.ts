import { describe, expect, it } from "vitest"
import { validateWriteRequest } from "./actions"

describe("validateWriteRequest", () => {
    it("接受合法的 rewrite 请求", () => {
        const result = validateWriteRequest({
            action: "rewrite",
            selectedText: "hello world",
            contextBefore: "前文",
            contextAfter: "后文",
        })
        expect(result).toMatchObject({
            action: "rewrite",
            selectedText: "hello world",
            language: null,
            tone: null,
        })
    })

    it("translate 必须带 language", () => {
        expect(() => validateWriteRequest({
            action: "translate",
            selectedText: "hi",
        })).toThrow()

        const ok = validateWriteRequest({
            action: "translate",
            selectedText: "hi",
            language: "ja",
        })
        expect(ok.language).toBe("ja")
    })

    it("tone 必须带 tone", () => {
        expect(() => validateWriteRequest({
            action: "tone",
            selectedText: "hi",
        })).toThrow()

        const ok = validateWriteRequest({
            action: "tone",
            selectedText: "hi",
            tone: "casual",
        })
        expect(ok.tone).toBe("casual")
    })

    it("非 continue 必须有 selectedText", () => {
        expect(() => validateWriteRequest({
            action: "rewrite",
            selectedText: "",
        })).toThrow()
    })

    it("continue 允许无选区但需要上文或选中文字之一", () => {
        const ok = validateWriteRequest({
            action: "continue",
            contextBefore: "上一段",
        })
        expect(ok.action).toBe("continue")

        expect(() => validateWriteRequest({
            action: "continue",
        })).toThrow()
    })

    it("超长 selectedText 被截断保留头", () => {
        const long = "我".repeat(10000)
        const result = validateWriteRequest({
            action: "rewrite",
            selectedText: long,
        })
        expect(result.selectedText.length).toBeLessThan(10000)
        expect(result.selectedText).toContain("[中间已截断]")
    })

    it("拒绝未知 action", () => {
        expect(() => validateWriteRequest({ action: "summary", selectedText: "x" })).toThrow()
    })

    it("非法语言/语气被忽略", () => {
        const result = validateWriteRequest({
            action: "rewrite",
            selectedText: "x",
            language: "klingon",
            tone: "shouty",
        })
        expect(result.language).toBeNull()
        expect(result.tone).toBeNull()
    })
})
