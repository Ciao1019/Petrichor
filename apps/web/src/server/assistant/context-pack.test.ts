import { describe, expect, it } from "vitest"
import {
    buildFoldableTranscript,
    buildInstructionsWithContextSummary,
    estimateMessageTokens,
    shouldRefreshContextSummary,
    splitRecentMessages,
    stripContextCompressParts,
    CONTEXT_COMPRESS_PART_TYPE,
    CONTEXT_RECENT_MESSAGE_COUNT,
} from "./context-pack"

describe("context-pack", () => {
    it("短对话不触发刷新", () => {
        const messages = Array.from({ length: 4 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            parts: [{ type: "text", text: `m${i}` }],
        }))
        expect(shouldRefreshContextSummary({
            messages,
            tokenBudget: 100_000,
            persistedMessageCount: 4,
        })).toBe(false)
    })

    it("消息条数超阈值触发刷新", () => {
        const messages = Array.from({ length: 12 }, (_, i) => ({
            role: "user",
            parts: [{ type: "text", text: `m${i}` }],
        }))
        expect(shouldRefreshContextSummary({
            messages,
            tokenBudget: 100_000,
            persistedMessageCount: 21,
        })).toBe(true)
    })

    it("切分保留最近 6 条", () => {
        const messages = Array.from({ length: 10 }, (_, i) => i)
        const { foldable, recent } = splitRecentMessages(messages)
        expect(recent).toEqual([4, 5, 6, 7, 8, 9])
        expect(foldable).toEqual([0, 1, 2, 3])
        expect(recent).toHaveLength(CONTEXT_RECENT_MESSAGE_COUNT)
    })

    it("instructions 注入摘要前缀", () => {
        const prompt = buildInstructionsWithContextSummary("基础提示", "用户在问 Mole 安装")
        expect(prompt).toContain("基础提示")
        expect(prompt).toContain("较早内容的摘要")
        expect(prompt).toContain("Mole")
    })

    it("剥离压缩临时 part", () => {
        const parts = stripContextCompressParts([
            { type: CONTEXT_COMPRESS_PART_TYPE, data: { status: "running" } },
            { type: "text", text: "你好" },
        ])
        expect(parts).toEqual([{ type: "text", text: "你好" }])
    })

    it("可折叠 transcript 抽取纯文本", () => {
        const text = buildFoldableTranscript([
            { role: "user", parts: [{ type: "text", text: "全部歌曲下载进度" }] },
            { role: "assistant", parts: [{ type: "text", text: "在 AI 库" }] },
        ])
        expect(text).toContain("全部歌曲下载进度")
        expect(text).toContain("在 AI 库")
        expect(estimateMessageTokens([{ a: "x".repeat(100) }])).toBeGreaterThan(10)
    })
})
