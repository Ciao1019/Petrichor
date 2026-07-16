import { describe, expect, it } from "vitest"
import {
    assistantFocusSchema,
    assistantIdSchema,
    assistantThreadDeleteManySchema,
    parseAssistantFocus,
    summarizeThreadTitle,
    toAssistantThreadResponse,
} from "./thread-logic"

describe("assistantIdSchema", () => {
    it("接受数字与数字字符串，归一化为 number", () => {
        expect(assistantIdSchema.parse(12)).toBe(12)
        expect(assistantIdSchema.parse("34")).toBe(34)
    })

    it("拒绝非正整数输入", () => {
        expect(() => assistantIdSchema.parse("abc")).toThrow()
        expect(() => assistantIdSchema.parse("-1")).toThrow()
    })
})

describe("assistantFocusSchema", () => {
    it("接受 string / number，归一化为字符串", () => {
        const focus = assistantFocusSchema.parse({ knowledgeBaseId: 7, libraryId: "8" })
        expect(focus.knowledgeBaseId).toBe("7")
        expect(focus.libraryId).toBe("8")
    })

    it("字段全部可空可缺省", () => {
        expect(assistantFocusSchema.parse({})).toEqual({})
        expect(assistantFocusSchema.parse({ articleId: null }).articleId).toBeNull()
    })
})

describe("summarizeThreadTitle", () => {
    it("空文本落默认标题，超长截断", () => {
        expect(summarizeThreadTitle("   ")).toBe("新对话")
        expect(summarizeThreadTitle("a".repeat(50))).toHaveLength(41)
    })
})

describe("parseAssistantFocus / toAssistantThreadResponse", () => {
    it("focus_json 解析失败时容错为 null", () => {
        expect(parseAssistantFocus("{bad json")).toBeNull()
        expect(parseAssistantFocus(null)).toBeNull()
    })

    it("thread 响应形状：id 字符串化、focus 解析、时间 ISO", () => {
        const now = new Date("2026-07-10T08:00:00.000Z")
        const response = toAssistantThreadResponse({
            id: 5,
            userId: 1,
            title: "部署问题",
            focusJson: JSON.stringify({ knowledgeBaseId: "3" }),
            contextSummaryMd: null,
            contextSummaryUntilMessageId: null,
            contextSummaryUpdatedAt: null,
            dangerAllowlistJson: null,
            operatorMemorySnapshotJson: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        })
        expect(response).toEqual({
            id: "5",
            title: "部署问题",
            focus: { knowledgeBaseId: "3" },
            createdAt: "2026-07-10T08:00:00.000Z",
            updatedAt: "2026-07-10T08:00:00.000Z",
        })
    })
})

describe("assistantThreadDeleteManySchema", () => {
    it("约束 1..200 且 id 归一化", () => {
        expect(assistantThreadDeleteManySchema.parse({ threadIds: ["1", 2] }).threadIds).toEqual([1, 2])
        expect(() => assistantThreadDeleteManySchema.parse({ threadIds: [] })).toThrow()
    })
})
