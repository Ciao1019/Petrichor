import { describe, expect, it } from "vitest"

import {
    adaptUnsupportedJsonSchemaResponseFormat,
    needsJsonPromptInjectionForStructuredOutput,
    prepareDeepSeekChatBody,
    resolveChatProtocolAdapter,
} from "./protocol-adapters"

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

describe("adaptUnsupportedJsonSchemaResponseFormat", () => {
    it("把 json_schema 降为 json_object 并注入 schema 提示", () => {
        const input = {
            model: "deepseek-v4-flash",
            messages: [{ role: "system", content: "只输出 JSON" }],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "intent",
                    schema: {
                        type: "object",
                        properties: { domains: { type: "array" } },
                    },
                },
            },
        }
        const adapted = adaptUnsupportedJsonSchemaResponseFormat(input) as {
            response_format: { type: string }
            messages: Array<{ role: string; content: string }>
        }
        expect(adapted).not.toBe(input)
        expect(adapted.response_format).toEqual({ type: "json_object" })
        expect(adapted.messages).toHaveLength(2)
        expect(adapted.messages[1]?.content).toContain("JSON")
        expect(adapted.messages[1]?.content).toContain("intent")
        expect(adapted.messages[1]?.content).toContain("domains")
    })

    it("非 json_schema 原样返回", () => {
        const input = {
            messages: [{ role: "user", content: "hi" }],
            response_format: { type: "json_object" },
        }
        expect(adaptUnsupportedJsonSchemaResponseFormat(input)).toBe(input)
    })
})

describe("prepareDeepSeekChatBody + resolveChatProtocolAdapter", () => {
    it("prepareDeepSeekChatBody 会先改写 json_schema", () => {
        const body = prepareDeepSeekChatBody({
            messages: [{ role: "user", content: "x" }],
            response_format: {
                type: "json_schema",
                json_schema: { name: "x", schema: { type: "object" } },
            },
        }, {
            maxTokens: null,
            temperature: null,
            deepSeekThinking: null,
            disableDeepSeekThinkingForTools: true,
        }) as { response_format: { type: string } }
        expect(body.response_format).toEqual({ type: "json_object" })
    })

    it("SiliconFlow DeepSeek 模型复用 DeepSeek 适配 fetch", () => {
        const adapter = resolveChatProtocolAdapter({
            protocol: "SILICONFLOW",
            baseUrl: "https://api.siliconflow.cn/v1",
            model: "deepseek-ai/DeepSeek-V3",
            name: "sf",
            options: {
                maxTokens: null,
                temperature: null,
                deepSeekThinking: null,
                disableDeepSeekThinkingForTools: true,
            },
        })
        expect(adapter.createFetch()).toEqual(expect.any(Function))
    })
})
