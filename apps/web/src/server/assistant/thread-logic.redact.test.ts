import { describe, expect, it } from "vitest"
import { redactAssistantStepInput } from "./thread-logic"

describe("redactAssistantStepInput", () => {
    it("脱敏 apiKey 等敏感字段", () => {
        expect(redactAssistantStepInput({
            configId: 1,
            apiKey: "sk-secret",
            nested: { password: "p", keep: "ok" },
        })).toEqual({
            configId: 1,
            apiKey: "[redacted]",
            nested: { password: "[redacted]", keep: "ok" },
        })
    })

    it("非对象原样返回", () => {
        expect(redactAssistantStepInput("x")).toBe("x")
        expect(redactAssistantStepInput(null)).toBeNull()
    })
})
