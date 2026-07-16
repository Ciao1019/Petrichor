import { describe, expect, it } from "vitest"
import { flattenAssistantUsage } from "./usage-meta"

describe("flattenAssistantUsage", () => {
    it("扁平字段原样保留并补 totalTokens", () => {
        expect(flattenAssistantUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
        })
    })

    it("兼容嵌套 total 形态", () => {
        expect(flattenAssistantUsage({
            inputTokens: { total: 3, noCache: 3 },
            outputTokens: { total: 7, text: 7 },
        })).toEqual({
            inputTokens: 3,
            outputTokens: 7,
            totalTokens: 10,
        })
    })

    it("空值返回 undefined", () => {
        expect(flattenAssistantUsage(null)).toBeUndefined()
        expect(flattenAssistantUsage({})).toBeUndefined()
    })
})
