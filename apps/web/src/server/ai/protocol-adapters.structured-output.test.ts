import { describe, expect, it } from "vitest"

import { needsJsonPromptInjectionForStructuredOutput } from "./protocol-adapters"

describe("needsJsonPromptInjectionForStructuredOutput", () => {
    it("DEEPSEEK 协议需要 jsonPromptInjection", () => {
        expect(needsJsonPromptInjectionForStructuredOutput({
            protocol: "DEEPSEEK",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-v4-flash",
            name: "DeepSeek",
        })).toBe(true)
    })

    it("OPENAI_COMPAT 指向 deepseek.com 也需要", () => {
        expect(needsJsonPromptInjectionForStructuredOutput({
            protocol: "OPENAI_COMPAT",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            name: "compat",
        })).toBe(true)
    })

    it("SiliconFlow 上的 DeepSeek 模型需要", () => {
        expect(needsJsonPromptInjectionForStructuredOutput({
            protocol: "SILICONFLOW",
            baseUrl: "https://api.siliconflow.cn/v1",
            model: "deepseek-ai/DeepSeek-V3",
            name: "sf",
        })).toBe(true)
    })

    it("原生 OpenAI 不需要", () => {
        expect(needsJsonPromptInjectionForStructuredOutput({
            protocol: "OPENAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4.1-mini",
            name: "OpenAI",
        })).toBe(false)
    })
})
