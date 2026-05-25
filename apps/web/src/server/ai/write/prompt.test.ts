import { describe, expect, it } from "vitest"
import { buildWriteSystemPrompt, buildWriteUserMessage } from "./prompt"

describe("buildWriteSystemPrompt", () => {
    it("不同 action 包含对应任务说明", () => {
        expect(buildWriteSystemPrompt("continue")).toContain("续写")
        expect(buildWriteSystemPrompt("rewrite")).toContain("改写")
        expect(buildWriteSystemPrompt("expand")).toContain("扩展")
        expect(buildWriteSystemPrompt("shorten")).toContain("精简")
        expect(buildWriteSystemPrompt("translate")).toContain("翻译")
        expect(buildWriteSystemPrompt("tone")).toContain("语气")
    })

    it("所有 system prompt 都包含基础规则", () => {
        const prompt = buildWriteSystemPrompt("rewrite")
        expect(prompt).toContain("纯文本结果")
        expect(prompt).toContain("Petrichor")
    })
})

describe("buildWriteUserMessage", () => {
    it("continue 注入 contextBefore 而非 selectedText 为主", () => {
        const msg = buildWriteUserMessage({
            action: "continue",
            selectedText: "",
            contextBefore: "ABCDE",
            contextAfter: "",
            language: null,
            tone: null,
        })
        expect(msg).toContain("ABCDE")
        expect(msg).toContain("续写")
    })

    it("translate 包含目标语言标签", () => {
        const msg = buildWriteUserMessage({
            action: "translate",
            selectedText: "你好",
            contextBefore: "",
            contextAfter: "",
            language: "en",
            tone: null,
        })
        expect(msg).toContain("英文")
        expect(msg).toContain("你好")
    })

    it("translate 没有 language 抛错", () => {
        expect(() => buildWriteUserMessage({
            action: "translate",
            selectedText: "你好",
            contextBefore: "",
            contextAfter: "",
            language: null,
            tone: null,
        })).toThrow()
    })

    it("tone 包含目标语气标签", () => {
        const msg = buildWriteUserMessage({
            action: "tone",
            selectedText: "随便写写",
            contextBefore: "",
            contextAfter: "",
            language: null,
            tone: "professional",
        })
        expect(msg).toContain("专业")
        expect(msg).toContain("随便写写")
    })
})
