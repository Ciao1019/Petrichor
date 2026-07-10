import { describe, expect, it } from "vitest"
import {
    buildFoldableTranscript,
    buildInstructionsWithContextSummary,
    estimateMessageTokens,
    resolveRecentWindowPolicy,
    shouldRefreshContextSummary,
    splitRecentMessages,
    stripContextCompressParts,
    CONTEXT_COMPRESS_PART_TYPE,
    CONTEXT_RECENT_MESSAGE_COUNT,
    CONTEXT_RECENT_MESSAGE_MAX,
    CONTEXT_RECENT_MESSAGE_MIN,
} from "./context-pack"

function makeMessages(count: number, text = "m") {
    return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `${text}${i}` }],
    }))
}

describe("context-pack", () => {
    it("短对话不触发刷新", () => {
        const messages = makeMessages(4)
        expect(shouldRefreshContextSummary({
            messages,
            tokenBudget: 100_000,
            persistedMessageCount: 4,
        })).toBe(false)
    })

    it("消息条数超阈值触发刷新", () => {
        const messages = makeMessages(12)
        expect(shouldRefreshContextSummary({
            messages,
            tokenBudget: 100_000,
            persistedMessageCount: 21,
        })).toBe(true)
    })

    it("切分保留最近 6 条（默认）", () => {
        const messages = Array.from({ length: 10 }, (_, i) => i)
        const { foldable, recent } = splitRecentMessages(messages)
        expect(recent).toEqual([4, 5, 6, 7, 8, 9])
        expect(foldable).toEqual([0, 1, 2, 3])
        expect(recent).toHaveLength(CONTEXT_RECENT_MESSAGE_COUNT)
    })

    it("切分可使用动态 recentCount", () => {
        const messages = Array.from({ length: 15 }, (_, i) => i)
        const { recent, foldable } = splitRecentMessages(messages, 10)
        expect(recent).toHaveLength(10)
        expect(foldable).toHaveLength(5)
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

describe("resolveRecentWindowPolicy", () => {
    it("消息 ≤ MIN 时 reason=fixed", () => {
        expect(resolveRecentWindowPolicy({
            messages: makeMessages(4),
            tokenBudget: 100_000,
        })).toEqual({ recentCount: 4, reason: "fixed" })

        expect(resolveRecentWindowPolicy({
            messages: makeMessages(CONTEXT_RECENT_MESSAGE_MIN),
            tokenBudget: 100_000,
        })).toEqual({ recentCount: CONTEXT_RECENT_MESSAGE_MIN, reason: "fixed" })
    })

    it("token 宽裕时扩张且 reason=token_budget", () => {
        const policy = resolveRecentWindowPolicy({
            messages: makeMessages(15, "short"),
            tokenBudget: 100_000,
        })
        expect(policy.recentCount).toBeGreaterThan(CONTEXT_RECENT_MESSAGE_MIN)
        expect(policy.recentCount).toBeLessThanOrEqual(CONTEXT_RECENT_MESSAGE_MAX)
        expect(policy.reason).toBe("token_budget")
    })

    it("触顶 MAX 时 reason=turn_budget", () => {
        const policy = resolveRecentWindowPolicy({
            messages: makeMessages(40, "x"),
            tokenBudget: 100_000,
        })
        expect(policy.recentCount).toBe(CONTEXT_RECENT_MESSAGE_MAX)
        expect(policy.reason).toBe("turn_budget")
    })

    it("单条极长无法扩张时停在 MIN 且 reason=fixed", () => {
        const huge = "汉".repeat(80_000)
        const messages = Array.from({ length: 12 }, (_, i) => ({
            role: "user",
            parts: [{ type: "text", text: `${huge}-${i}` }],
        }))
        const policy = resolveRecentWindowPolicy({
            messages,
            tokenBudget: 10_000,
        })
        expect(policy.recentCount).toBe(CONTEXT_RECENT_MESSAGE_MIN)
        expect(policy.reason).toBe("fixed")
    })
})
