import { describe, expect, it } from "vitest"
import {
    catalogModelsOf,
    findCatalogModel,
    findProvider,
    guessContextWindow,
    guessModelKind,
    listCatalogSummaries,
    PROVIDER_CATALOG,
    requireProvider,
    resolveApiProtocol,
    resolveBaseUrl,
    supportedApiProtocols,
    validateBaseUrl,
} from "./provider-catalog"

describe("provider catalog", () => {
    it("供应商 key 唯一，且都声明了至少一种模型类型", () => {
        const keys = PROVIDER_CATALOG.map((provider) => provider.key)
        expect(new Set(keys).size).toBe(keys.length)
        for (const provider of PROVIDER_CATALOG) {
            expect(provider.kinds.length).toBeGreaterThan(0)
            expect(provider.name).toBeTruthy()
        }
    })

    it("没有默认 BaseUrl 的供应商，要么必填 BaseUrl，要么由 SDK 自行拼接", () => {
        const sdkResolved = ["google-vertex", "azure", "amazon-bedrock"]
        for (const provider of PROVIDER_CATALOG) {
            if (provider.defaultBaseUrl != null) continue
            expect(provider.baseUrlRequired || sdkResolved.includes(provider.key)).toBe(true)
        }
    })

    it("内置模型清单的 kind 与所属供应商声明一致", () => {
        for (const provider of PROVIDER_CATALOG) {
            for (const model of provider.models) {
                expect(provider.kinds).toContain(model.kind)
            }
        }
    })

    it("findProvider / requireProvider 行为符合预期", () => {
        expect(findProvider("openai")?.name).toBe("OpenAI")
        expect(findProvider("  ")).toBeNull()
        expect(findProvider("nope")).toBeNull()
        expect(() => requireProvider("nope")).toThrow(/未知的供应商/)
    })

    it("resolveBaseUrl 用户值优先并去掉尾部斜杠，留空回落默认值", () => {
        const openai = requireProvider("openai")
        expect(resolveBaseUrl(openai, "https://proxy.test/v1///")).toBe("https://proxy.test/v1")
        expect(resolveBaseUrl(openai, "  ")).toBe("https://api.openai.com/v1")
        expect(resolveBaseUrl(openai, null)).toBe("https://api.openai.com/v1")
    })

    it("baseUrlRequired 的供应商没填 BaseUrl 时报错", () => {
        const custom = requireProvider("openai-compatible")
        expect(() => validateBaseUrl(custom, null)).toThrow(/必须填写 BaseUrl/)
        expect(validateBaseUrl(custom, "https://my.gateway/v1")).toBe("https://my.gateway/v1")
    })

    it("guessModelKind 按命名约定识别向量模型", () => {
        expect(guessModelKind("text-embedding-3-large")).toBe("EMBEDDING")
        expect(guessModelKind("BAAI/bge-m3")).toBe("EMBEDDING")
        expect(guessModelKind("gte-large-zh")).toBe("EMBEDDING")
        expect(guessModelKind("gpt-5.2")).toBe("LANGUAGE")
        expect(guessModelKind("claude-sonnet-4-5")).toBe("LANGUAGE")
    })

    it("guessContextWindow 覆盖主流模型家族并有兜底值", () => {
        expect(guessContextWindow("claude-opus-4-5")).toBe(200_000)
        expect(guessContextWindow("gemini-2.5-pro")).toBe(2_000_000)
        expect(guessContextWindow("deepseek-chat")).toBe(1_000_000)
        expect(guessContextWindow("deepseek-r1")).toBe(64_000)
        expect(guessContextWindow("glm-4.6")).toBe(128_000)
        expect(guessContextWindow("some-unknown-model")).toBe(128_000)
    })

    it("catalogModelsOf 可按类型过滤，findCatalogModel 命中内置元信息", () => {
        const openai = requireProvider("openai")
        const embeddings = catalogModelsOf(openai, "EMBEDDING")
        expect(embeddings.length).toBeGreaterThan(0)
        expect(embeddings.every((model) => model.kind === "EMBEDDING")).toBe(true)
        expect(findCatalogModel(openai, " gpt-5.2 ")?.contextWindow).toBe(400_000)
        expect(findCatalogModel(openai, "not-exist")).toBeNull()
    })

    it("目录摘要给前端暴露了模型列表能力标记", () => {
        const summaries = listCatalogSummaries()
        expect(summaries).toHaveLength(PROVIDER_CATALOG.length)
        expect(summaries.find((item) => item.key === "openai")?.supportsModelListing).toBe(true)
        expect(summaries.find((item) => item.key === "perplexity")?.supportsModelListing).toBe(false)
        expect(summaries.find((item) => item.key === "amazon-bedrock")?.credentialFields.length)
            .toBeGreaterThan(0)
        expect(summaries.find((item) => item.key === "openai")?.apiProtocols)
            .toEqual(["chat", "responses"])
        expect(summaries.find((item) => item.key === "deepseek")?.apiProtocols).toEqual(["chat"])
    })

    /**
     * 协议默认值必须是 chat：SDK 的隐式默认是 responses，
     * 而绝大多数「OpenAI 兼容」端点只实现了 /chat/completions。
     */
    it("默认协议是 chat，且非法值回落到默认值", () => {
        for (const provider of PROVIDER_CATALOG) {
            expect(supportedApiProtocols(provider)[0]).toBe("chat")
            expect(resolveApiProtocol(provider, null)).toBe("chat")
            expect(resolveApiProtocol(provider, "")).toBe("chat")
            expect(resolveApiProtocol(provider, "nonsense")).toBe("chat")
        }
    })

    it("只有支持 responses 的供应商能选到 responses", () => {
        expect(resolveApiProtocol(requireProvider("openai"), "responses")).toBe("responses")
        expect(resolveApiProtocol(requireProvider("azure"), "responses")).toBe("responses")
        expect(resolveApiProtocol(requireProvider("xai"), "responses")).toBe("responses")
        // 其余供应商即使传了 responses 也回落到 chat
        expect(resolveApiProtocol(requireProvider("deepseek"), "responses")).toBe("chat")
        expect(resolveApiProtocol(requireProvider("openai-compatible"), "responses")).toBe("chat")
    })
})
