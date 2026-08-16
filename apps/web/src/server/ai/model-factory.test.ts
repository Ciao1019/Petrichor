import { describe, expect, it } from "vitest"
import { PROVIDER_CATALOG, requireProvider } from "./provider-catalog"
import { createLanguageModel, createTextEmbeddingModel, type ProviderRuntimeConfig } from "./model-factory"

/**
 * 这些用例只构造 provider 实例，不发任何网络请求。
 * 目的是在 CI 里守住「目录新增了一个供应商，但工厂里忘了加分支」这类漏配。
 */

/** 需要额外凭证字段的供应商，用假值补齐 */
const EXTRA_BY_PROVIDER: Record<string, Record<string, string>> = {
    "google-vertex": {
        project: "demo-project",
        location: "us-central1",
        clientEmail: "svc@demo.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    },
    azure: { resourceName: "demo-resource" },
    "amazon-bedrock": {
        region: "us-east-1",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
    },
}

function runtimeConfigFor(providerKey: string): ProviderRuntimeConfig {
    const provider = requireProvider(providerKey)
    return {
        providerKey,
        baseUrl: provider.baseUrlRequired ? "https://custom.example/v1" : null,
        apiKey: "test-key",
        extra: EXTRA_BY_PROVIDER[providerKey] ?? {},
        headers: {},
    }
}

describe("model factory", () => {
    const languageProviders = PROVIDER_CATALOG.filter((provider) => provider.kinds.includes("LANGUAGE"))
    const embeddingProviders = PROVIDER_CATALOG.filter((provider) => provider.kinds.includes("EMBEDDING"))

    it.each(languageProviders.map((provider) => provider.key))(
        "%s 能构造语言模型",
        async (providerKey) => {
            const provider = requireProvider(providerKey)
            const modelId = provider.models.find((model) => model.kind === "LANGUAGE")?.id ?? "test-model"
            const model = await createLanguageModel(runtimeConfigFor(providerKey), modelId)
            expect(model).toBeTruthy()
        },
    )

    it.each(embeddingProviders.map((provider) => provider.key))(
        "%s 能构造向量模型",
        async (providerKey) => {
            const provider = requireProvider(providerKey)
            const modelId = provider.models.find((model) => model.kind === "EMBEDDING")?.id ?? "test-embedding"
            const model = await createTextEmbeddingModel(runtimeConfigFor(providerKey), modelId)
            expect(model).toBeTruthy()
        },
    )

    it("未知供应商直接报错", async () => {
        await expect(createLanguageModel(
            { providerKey: "nope", baseUrl: null, apiKey: "k", extra: {}, headers: {} },
            "m",
        )).rejects.toThrow(/未知的供应商/)
    })

    it("缺少必填的额外凭证字段时给出可读提示", async () => {
        await expect(createLanguageModel(
            { providerKey: "amazon-bedrock", baseUrl: null, apiKey: "k", extra: {}, headers: {} },
            "anthropic.claude-sonnet-4-5-20250929-v1:0",
        )).rejects.toThrow(/缺少必填凭证字段：Region/)
    })

    it("自定义兼容端点没填 BaseUrl 时报错", async () => {
        await expect(createLanguageModel(
            { providerKey: "openai-compatible", baseUrl: null, apiKey: "k", extra: {}, headers: {} },
            "m",
        )).rejects.toThrow(/必须填写 BaseUrl/)
    })

    it("Voyage 只提供向量模型", async () => {
        await expect(createLanguageModel(runtimeConfigFor("voyage"), "voyage-3-large"))
            .rejects.toThrow(/不提供语言模型/)
    })
})

/**
 * chat / responses 协议选择。
 *
 * 回归防护：`@ai-sdk/openai` v4 起 `provider.languageModel(id)` 返回的是 Responses 模型。
 * 旧实现用 `provider.chat(id)` 打 /chat/completions，直接换成 languageModel 会让所有
 * 把 BaseUrl 指到中转网关的 OpenAI 接入全部 404。这里守住「默认仍是 chat，
 * 且只有显式选了才走 responses」。
 */
describe("语言模型协议选择", () => {
    /** provider 名里带 .responses / .chat，可以直接从实例上读出走的是哪套 */
    function protocolOf(model: unknown): string {
        const provider = (model as { provider?: string }).provider ?? ""
        if (provider.endsWith(".responses")) return "responses"
        if (provider.endsWith(".chat")) return "chat"
        return provider
    }

    it.each(["openai", "azure", "xai"])("%s 不指定协议时默认走 chat completions", async (providerKey) => {
        const model = await createLanguageModel(runtimeConfigFor(providerKey), "gpt-4o")
        expect(protocolOf(model)).toBe("chat")
    })

    it.each(["openai", "azure", "xai"])("%s 显式选 responses 时走 responses", async (providerKey) => {
        const model = await createLanguageModel(
            { ...runtimeConfigFor(providerKey), apiProtocol: "responses" },
            "gpt-4o",
        )
        expect(protocolOf(model)).toBe("responses")
    })

    it("非法协议值回落到目录默认值，不会抛错", async () => {
        const model = await createLanguageModel(
            { ...runtimeConfigFor("openai"), apiProtocol: "RESPONSES!" as never },
            "gpt-4o",
        )
        expect(protocolOf(model)).toBe("chat")
    })

    it("只有一套协议的供应商忽略 apiProtocol，仍用 SDK 原生入口", async () => {
        const model = await createLanguageModel(
            { ...runtimeConfigFor("anthropic"), apiProtocol: "responses" },
            "claude-sonnet-4-5",
        )
        expect(model).toBeTruthy()
    })
})
