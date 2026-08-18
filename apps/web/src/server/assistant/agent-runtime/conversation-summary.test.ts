import { describe, expect, it } from "vitest"
import { parseSummary, renderTranscript, shouldSummarize, SUMMARY_MIN_MESSAGES } from "./conversation-summary"

function messages(count: number, chars = 600) {
    return Array.from({ length: count }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `第 ${index} 轮的内容：${"讨论细节".repeat(Math.ceil(chars / 4))}`,
    }))
}

describe("摘要触发条件", () => {
    it("短会话不摘要", () => {
        expect(shouldSummarize(messages(4))).toBe(false)
    })

    it("轮次够但内容很短也不摘要", () => {
        const short = Array.from({ length: SUMMARY_MIN_MESSAGES + 2 }, () => ({ role: "user", content: "好" }))
        expect(shouldSummarize(short)).toBe(false)
    })

    it("长会话触发摘要", () => {
        expect(shouldSummarize(messages(20))).toBe(true)
    })
})

describe("parseSummary", () => {
    it("解析标准 JSON", () => {
        const summary = parseSummary(JSON.stringify({
            goals: ["迁移 Redis 队列"],
            decisions: ["改用 Streams"],
            importantFacts: ["当前 Redis 6.2"],
            unresolvedQuestions: ["消费者组命名规范未定"],
        }))
        expect(summary?.goals).toEqual(["迁移 Redis 队列"])
        expect(summary?.unresolvedQuestions).toHaveLength(1)
    })

    it("容忍代码块包裹与前后噪声", () => {
        const summary = parseSummary('```json\n{"goals":["A"],"decisions":[],"importantFacts":[],"unresolvedQuestions":[]}\n```')
        expect(summary?.goals).toEqual(["A"])
    })

    it("超量条目会被截断", () => {
        const summary = parseSummary(JSON.stringify({
            goals: ["1", "2", "3", "4", "5", "6"],
            decisions: [],
            importantFacts: [],
            unresolvedQuestions: [],
        }))
        expect(summary?.goals).toHaveLength(4)
    })

    it("非字符串条目被过滤", () => {
        const summary = parseSummary(JSON.stringify({
            goals: ["有效", 42, null, "  "],
            decisions: [],
            importantFacts: [],
            unresolvedQuestions: [],
        }))
        expect(summary?.goals).toEqual(["有效"])
    })

    it("非法输出返回 null 而不是抛错", () => {
        expect(parseSummary("我觉得这段对话主要在讨论 Redis")).toBeNull()
        expect(parseSummary("")).toBeNull()
    })

    it("全空摘要视为无效", () => {
        expect(parseSummary(JSON.stringify({
            goals: [], decisions: [], importantFacts: [], unresolvedQuestions: [],
        }))).toBeNull()
    })
})

describe("renderTranscript", () => {
    it("只取最近 N 条并标注角色", () => {
        const text = renderTranscript(messages(10, 20), 2)
        expect(text.split("\n")).toHaveLength(2)
        expect(text).toContain("助手：")
    })

    it("支持 parts 形式的消息", () => {
        const text = renderTranscript([
            { role: "user", parts: [{ type: "text", text: "你好" }, { type: "tool-call" }] },
        ], 5)
        expect(text).toBe("用户：你好")
    })
})
