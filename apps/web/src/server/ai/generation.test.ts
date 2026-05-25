import { describe, expect, it } from "vitest"
import {
    isDeepSeekOpenAICompatibleConfig,
    prepareOpenAICompatibleChatBodyForProvider,
} from "@/server/ai/generation"
import { resolveChatProtocolAdapter } from "@/server/ai/protocol-adapters"

const baseOptions = {
    maxTokens: null,
    temperature: null,
    deepSeekThinking: null,
    disableDeepSeekThinkingForTools: true,
} as const

describe("DeepSeek OpenAI 兼容请求体", () => {
    it("DeepSeek 工具请求默认关闭 thinking", () => {
        const body = {
            messages: [{ role: "user", content: "读取文档" }],
            model: "deepseek-chat",
            stream: true,
            tools: [{ type: "function", function: { name: "read_wiki_index" } }],
        }

        const result = prepareOpenAICompatibleChatBodyForProvider({
            body,
            context: {
                isDeepSeekProvider: true,
                deepSeekThinking: null,
                disableDeepSeekThinkingForTools: true,
            },
        })

        expect(result).toEqual({
            ...body,
            thinking: { type: "disabled" },
        })
    })

    it("非 DeepSeek 请求不改写请求体", () => {
        const body = {
            messages: [{ role: "user", content: "读取文档" }],
            model: "gpt-4.1",
            stream: true,
            tools: [{ type: "function", function: { name: "read_wiki_index" } }],
        }

        const result = prepareOpenAICompatibleChatBodyForProvider({
            body,
            context: {
                isDeepSeekProvider: false,
                deepSeekThinking: null,
                disableDeepSeekThinkingForTools: true,
            },
        })

        expect(result).toBe(body)
    })

    it("DeepSeek 无工具请求默认保留服务端 thinking 策略", () => {
        const body = {
            messages: [{ role: "user", content: "总结文档" }],
            model: "deepseek-chat",
            stream: false,
        }

        const result = prepareOpenAICompatibleChatBodyForProvider({
            body,
            context: {
                isDeepSeekProvider: true,
                deepSeekThinking: null,
                disableDeepSeekThinkingForTools: true,
            },
        })

        expect(result).toBe(body)
    })

    it("显式 DeepSeek thinking 配置会写入普通请求", () => {
        const body = {
            messages: [{ role: "user", content: "总结文档" }],
            model: "deepseek-chat",
            stream: false,
        }

        const result = prepareOpenAICompatibleChatBodyForProvider({
            body,
            context: {
                isDeepSeekProvider: true,
                deepSeekThinking: "disabled",
                disableDeepSeekThinkingForTools: true,
            },
        })

        expect(result).toEqual({
            ...body,
            thinking: { type: "disabled" },
        })
    })

    it("工具请求的保护策略优先于显式开启 thinking", () => {
        const body = {
            messages: [{ role: "user", content: "读取文档" }],
            model: "deepseek-chat",
            stream: true,
            tools: [{ type: "function", function: { name: "read_wiki_index" } }],
        }

        const result = prepareOpenAICompatibleChatBodyForProvider({
            body,
            context: {
                isDeepSeekProvider: true,
                deepSeekThinking: "enabled",
                disableDeepSeekThinkingForTools: true,
            },
        })

        expect(result).toEqual({
            ...body,
            thinking: { type: "disabled" },
        })
    })

    it("只把 DeepSeek 官方或 OpenAI 兼容配置识别为 DeepSeek provider", () => {
        expect(isDeepSeekOpenAICompatibleConfig({
            baseURL: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            name: "DeepSeek",
            protocol: "OPENAI_COMPAT",
        })).toBe(true)

        expect(isDeepSeekOpenAICompatibleConfig({
            baseURL: "https://api.siliconflow.cn/v1",
            model: "deepseek-ai/DeepSeek-R1",
            name: "SiliconFlow",
            protocol: "SILICONFLOW",
        })).toBe(false)
    })
})

describe("协议适配器路由", () => {
    it("DEEPSEEK 协议走 DeepSeek 适配器：注入 thinking + 解析 reasoning_content", () => {
        const adapter = resolveChatProtocolAdapter({
            protocol: "DEEPSEEK",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            name: "默认 DeepSeek",
            options: { ...baseOptions, deepSeekThinking: "enabled" },
        })
        const body = { messages: [], model: "deepseek-chat", stream: false }
        expect(adapter.prepareChatBody(body)).toEqual({ ...body, thinking: { type: "enabled" } })
        expect(adapter.extractReasoning({ reasoning_content: " 思考过程 ", reasoning: "" })).toBe("思考过程")
        expect(adapter.createFetch()).toBeTypeOf("function")
    })

    it("OPENAI 协议不注入 thinking，且仅从 reasoning 字段提取", () => {
        const adapter = resolveChatProtocolAdapter({
            protocol: "OPENAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4.1",
            name: "OpenAI 主线",
            options: { ...baseOptions, deepSeekThinking: "enabled" },
        })
        const body = { messages: [], model: "gpt-4.1", stream: false }
        expect(adapter.prepareChatBody(body)).toBe(body)
        // 即便上游误返回 reasoning_content，OpenAI 协议也不应当透传 DeepSeek 私有字段
        expect(adapter.extractReasoning({ reasoning_content: "x", reasoning: undefined })).toBeNull()
        expect(adapter.extractReasoning({ reasoning: "summary" })).toBe("summary")
        expect(adapter.createFetch()).toBeUndefined()
    })

    it("OPENAI_COMPAT 接 deepseek.com 仍然回退到 DeepSeek 适配器（向后兼容）", () => {
        const adapter = resolveChatProtocolAdapter({
            protocol: "OPENAI_COMPAT",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-chat",
            name: "旧 DeepSeek 配置",
            options: { ...baseOptions, deepSeekThinking: "enabled" },
        })
        const body = { messages: [], model: "deepseek-chat", stream: false }
        expect(adapter.prepareChatBody(body)).toEqual({ ...body, thinking: { type: "enabled" } })
    })

    it("OPENAI_COMPAT 非 DeepSeek 配置走通用兼容路径，不注入 thinking", () => {
        const adapter = resolveChatProtocolAdapter({
            protocol: "OPENAI_COMPAT",
            baseUrl: "https://example.com/v1",
            model: "qwen-max",
            name: "Custom",
            options: { ...baseOptions, deepSeekThinking: "enabled" },
        })
        const body = { messages: [], model: "qwen-max", stream: false }
        expect(adapter.prepareChatBody(body)).toBe(body)
        expect(adapter.createFetch()).toBeUndefined()
    })
})
