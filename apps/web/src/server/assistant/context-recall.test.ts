import { describe, expect, it } from "vitest"
import {
    buildInstructionsWithContextExtras,
    sanitizeRecallExcerpt,
} from "./context-recall"

describe("sanitizeRecallExcerpt", () => {
    it("遮蔽 api key / bearer / cookie 形态", () => {
        const text = sanitizeRecallExcerpt(
            "user: api_key=sk-abcdefghijklmnop password: secret123 Bearer tok_abc cookie: sid=1",
        )
        expect(text).not.toContain("sk-abcdefghijklmnop")
        expect(text).toContain("[redacted]")
        expect(text.toLowerCase()).not.toContain("secret123")
    })

    it("截断过长摘录", () => {
        const text = sanitizeRecallExcerpt(`user: ${"汉".repeat(800)}`)
        expect(text.length).toBeLessThanOrEqual(501)
        expect(text.endsWith("…")).toBe(true)
    })
})

describe("buildInstructionsWithContextExtras", () => {
    it("可同时注入摘要与召回片段", () => {
        const prompt = buildInstructionsWithContextExtras(
            "基础提示",
            "用户在部署 Mole",
            [{ messageId: "9", score: 0.81, excerpt: "user: 之前提到端口 8080" }],
        )
        expect(prompt).toContain("基础提示")
        expect(prompt).toContain("较早内容的摘要")
        expect(prompt).toContain("Mole")
        expect(prompt).toContain("向量召回")
        expect(prompt).toContain("8080")
        expect(prompt).toContain("0.81")
    })

    it("无摘要无召回时原样返回", () => {
        expect(buildInstructionsWithContextExtras("基础", null, [])).toBe("基础")
        expect(buildInstructionsWithContextExtras("基础", null, null)).toBe("基础")
    })
})
