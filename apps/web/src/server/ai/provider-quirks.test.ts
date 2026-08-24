import { afterEach, describe, expect, it, vi } from "vitest"
import {
    createQuirkFetch,
    downgradeJsonSchemaResponseFormat,
    extractReasoning,
    injectThinkingFlag,
    needsJsonPromptInjectionForStructuredOutput,
    needsQuirkFetch,
    resolveQuirks,
    type ProviderFetch,
} from "./provider-quirks"

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("resolveQuirks", () => {
    it("DeepSeek 官方接口需要降级 json_schema", () => {
        expect(resolveQuirks("deepseek", "deepseek-chat").downgradeJsonSchema).toBe(true)
    })

    it("聚合平台上托管的 DeepSeek 模型继承同样的限制", () => {
        expect(resolveQuirks("siliconflow", "deepseek-ai/DeepSeek-V3").downgradeJsonSchema).toBe(true)
        expect(resolveQuirks("openrouter", "deepseek/deepseek-chat").downgradeJsonSchema).toBe(true)
    })

    it("普通供应商没有任何怪癖", () => {
        expect(resolveQuirks("openai", "gpt-5.2")).toEqual({
            downgradeJsonSchema: false,
            supportsThinkingFlag: false,
        })
        expect(needsQuirkFetch("openai", "gpt-5.2")).toBe(false)
        expect(needsQuirkFetch("anthropic", "claude-sonnet-4-5")).toBe(false)
    })

    it("needsJsonPromptInjectionForStructuredOutput 与降级判定一致", () => {
        expect(needsJsonPromptInjectionForStructuredOutput("deepseek", "deepseek-chat")).toBe(true)
        expect(needsJsonPromptInjectionForStructuredOutput("openai", "gpt-5.2")).toBe(false)
    })
})

describe("downgradeJsonSchemaResponseFormat", () => {
    it("把 json_schema 降级为 json_object 并把 schema 注入 messages", () => {
        const result = downgradeJsonSchemaResponseFormat({
            messages: [{ role: "user", content: "hi" }],
            response_format: {
                type: "json_schema",
                json_schema: { name: "route", schema: { type: "object" } },
            },
        }) as Record<string, unknown>

        expect(result.response_format).toEqual({ type: "json_object" })
        const messages = result.messages as { role: string; content: string }[]
        expect(messages).toHaveLength(2)
        expect(messages[1].content).toContain("Schema name: route")
        expect(messages[1].content).toContain("JSON schema:")
        // DeepSeek 要求 prompt 里出现 json 字样
        expect(messages[1].content.toLowerCase()).toContain("json")
    })

    it("非 json_schema 的请求体原样返回", () => {
        const body = { messages: [], response_format: { type: "json_object" } }
        expect(downgradeJsonSchemaResponseFormat(body)).toBe(body)
        expect(downgradeJsonSchemaResponseFormat("nope")).toBe("nope")
    })
})

describe("injectThinkingFlag", () => {
    const enabled = { thinking: "enabled" as const, disableThinkingForTools: true }

    it("无工具时按配置注入 thinking", () => {
        const result = injectThinkingFlag({ messages: [] }, enabled) as Record<string, unknown>
        expect(result.thinking).toEqual({ type: "enabled" })
    })

    it("带工具时强制关闭，避免缺少 reasoning_content 导致 400", () => {
        const result = injectThinkingFlag({ messages: [], tools: [{ name: "t" }] }, enabled) as Record<string, unknown>
        expect(result.thinking).toEqual({ type: "disabled" })
    })

    it("带工具但允许思考时保留配置值", () => {
        const result = injectThinkingFlag(
            { messages: [], tools: [{ name: "t" }] },
            { thinking: "enabled", disableThinkingForTools: false },
        ) as Record<string, unknown>
        expect(result.thinking).toEqual({ type: "enabled" })
    })

    it("未配置 thinking 时不改动请求体", () => {
        const body = { messages: [] }
        expect(injectThinkingFlag(body, { thinking: null, disableThinkingForTools: true })).toBe(body)
    })
})

describe("createQuirkFetch", () => {
    it("对没有怪癖的供应商返回 undefined", () => {
        expect(createQuirkFetch({ providerKey: "openai", modelId: "gpt-5.2" })).toBeUndefined()
    })

    it("只改写 /chat/completions 请求", async () => {
        const base = vi.fn<ProviderFetch>(async () => new Response("{}", { status: 200 }))
        vi.stubGlobal("fetch", base)

        const quirkFetch = createQuirkFetch({
            providerKey: "deepseek",
            modelId: "deepseek-chat",
            options: { thinking: "enabled", disableThinkingForTools: true },
        })!

        await quirkFetch("https://api.deepseek.com/v1/models", { method: "GET" })
        expect(base.mock.calls[0]?.[1]).toEqual({ method: "GET" })

        await quirkFetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            body: JSON.stringify({ messages: [], model: "deepseek-chat" }),
        })
        const rewritten = JSON.parse(base.mock.calls[1]?.[1]?.body as string)
        expect(rewritten.thinking).toEqual({ type: "enabled" })
    })

    /**
     * 回归防护：URL 匹配只认 /chat/completions 的话，供应商切到 Responses 协议后
     * 怪癖修正会静默失效——请求照发，但 json_schema 降级没应用，表现为莫名其妙的 400。
     */
    it("Responses 协议的请求同样被改写", async () => {
        const base = vi.fn<ProviderFetch>(async () => new Response("{}", { status: 200 }))
        vi.stubGlobal("fetch", base)

        const quirkFetch = createQuirkFetch({
            providerKey: "deepseek",
            modelId: "deepseek-chat",
            options: { thinking: "enabled", disableThinkingForTools: true },
        })!

        await quirkFetch("https://api.deepseek.com/v1/responses", {
            method: "POST",
            body: JSON.stringify({ messages: [], model: "deepseek-chat" }),
        })
        const rewritten = JSON.parse(base.mock.calls[0]?.[1]?.body as string)
        expect(rewritten.thinking).toEqual({ type: "enabled" })
    })

    it("URL 里只是碰巧含 responses 字样的路径不被改写", async () => {
        const base = vi.fn<ProviderFetch>(async () => new Response("{}", { status: 200 }))
        vi.stubGlobal("fetch", base)

        const quirkFetch = createQuirkFetch({
            providerKey: "deepseek",
            modelId: "deepseek-chat",
            options: { thinking: "enabled", disableThinkingForTools: true },
        })!

        await quirkFetch("https://api.deepseek.com/v1/responses/abc/cancel", {
            method: "POST",
            body: JSON.stringify({ messages: [] }),
        })
        const passed = JSON.parse(base.mock.calls[0]?.[1]?.body as string)
        expect(passed.thinking).toBeUndefined()
    })

    it("请求体不是 JSON 时原样透传", async () => {
        const base = vi.fn<ProviderFetch>(async () => new Response("{}", { status: 200 }))
        vi.stubGlobal("fetch", base)
        const quirkFetch = createQuirkFetch({ providerKey: "deepseek", modelId: "deepseek-chat" })!
        await quirkFetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            body: "not-json",
        })
        expect(base.mock.calls[0]?.[1]?.body).toBe("not-json")
    })
})

describe("extractReasoning", () => {
    it("兼容 reasoning_content 与 reasoning 两种字段名", () => {
        expect(extractReasoning({ reasoning_content: " 思考 " })).toBe("思考")
        expect(extractReasoning({ reasoning: "abc" })).toBe("abc")
        expect(extractReasoning({ reasoning_content: "  " })).toBeNull()
        expect(extractReasoning(undefined)).toBeNull()
    })
})
