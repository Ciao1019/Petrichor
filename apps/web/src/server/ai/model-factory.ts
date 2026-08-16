/**
 * 模型工厂：把一条「供应商实例 + 凭证 + 模型 id」变成 AI SDK 的 LanguageModel / EmbeddingModel。
 *
 * 每个供应商用动态 import 按需加载对应的 @ai-sdk 包，避免一次性把 24 个 provider
 * 全部拉进同一个 serverless 函数。没有官方包的供应商统一走 openai-compatible。
 */

import type { EmbeddingModel, LanguageModel } from "ai"
import {
    requireProvider,
    resolveApiProtocol,
    resolveBaseUrl,
    type ApiProtocol,
    type ProviderDefinition,
} from "@/server/ai/provider-catalog"
import { createQuirkFetch, type ProviderQuirkOptions } from "@/server/ai/provider-quirks"

export interface ProviderRuntimeConfig {
    providerKey: string
    /** 用户覆盖的 BaseUrl，null 表示用供应商默认值 */
    baseUrl: string | null
    apiKey: string
    /** 供应商额外凭证字段（Bedrock 的 region/AK/SK、Vertex 的服务账号等） */
    extra: Record<string, string>
    /** 用户自定义请求头 */
    headers: Record<string, string>
    /** 语言模型协议（chat completions / responses）；未指定时取目录默认值 */
    apiProtocol?: ApiProtocol | null
    /** 怪癖开关（DeepSeek thinking 等） */
    quirks?: Partial<ProviderQuirkOptions>
}

/** 供应商 SDK 实例的最小公共形状 */
interface ProviderInstance {
    languageModel?: (modelId: string) => unknown
    /** OpenAI 系 SDK 的显式协议入口，存在时优先于 languageModel */
    chat?: (modelId: string) => unknown
    responses?: (modelId: string) => unknown
    textEmbeddingModel?: (modelId: string) => unknown
}

export async function createLanguageModel(config: ProviderRuntimeConfig, modelId: string): Promise<LanguageModel> {
    const provider = requireProvider(config.providerKey)
    // 先按目录声明拦一道：部分 SDK 的 languageModel 存在但调用时才抛出晦涩错误
    if (!provider.kinds.includes("LANGUAGE")) {
        throw new Error(`${provider.name} 不提供语言模型`)
    }
    const instance = await instantiateProvider(provider, config, modelId)
    const factory = pickLanguageModelFactory(provider, instance, config.apiProtocol)
    if (!factory) {
        throw new Error(`${provider.name} 不提供语言模型`)
    }
    return factory(modelId) as LanguageModel
}

/**
 * 按显式协议挑入口，不用 SDK 的隐式默认值。
 *
 * `@ai-sdk/openai` / `azure` / `xai` 的 `languageModel()` 都指向 Responses API，
 * 但这三家的 BaseUrl 常被指到只实现了 /chat/completions 的中转网关或私有部署，
 * 用默认值会直接 404。这些供应商在目录里声明了 `apiProtocols`，
 * 这里就按「目录默认值 + 用户选择」显式取 `.chat` / `.responses`。
 *
 * 其余供应商只有一套协议（Anthropic 的 /v1/messages、Gemini 原生接口、
 * Bedrock 的 SigV4、以及各家 OpenAI 兼容端点的 /chat/completions），
 * 走 SDK 的统一入口即可。
 */
function pickLanguageModelFactory(
    provider: ProviderDefinition,
    instance: ProviderInstance,
    override: ApiProtocol | null | undefined,
): ((modelId: string) => unknown) | null {
    if (provider.apiProtocols?.length) {
        const protocol = resolveApiProtocol(provider, override)
        const explicit = protocol === "responses" ? instance.responses : instance.chat
        if (typeof explicit !== "function") {
            throw new Error(`${provider.name} 的 SDK 未提供 ${protocol} 协议入口`)
        }
        return explicit
    }
    return typeof instance.languageModel === "function" ? instance.languageModel : null
}

export async function createTextEmbeddingModel(config: ProviderRuntimeConfig, modelId: string): Promise<EmbeddingModel> {
    const provider = requireProvider(config.providerKey)
    if (!provider.kinds.includes("EMBEDDING")) {
        throw new Error(`${provider.name} 不提供向量模型`)
    }
    const instance = await instantiateProvider(provider, config, modelId)
    if (typeof instance.textEmbeddingModel === "function") {
        return instance.textEmbeddingModel(modelId) as EmbeddingModel
    }
    // 部分官方包（moonshotai / alibaba）只实现了语言模型，
    // 向量能力回落到同一端点的 OpenAI 兼容实现。
    const fallback = await createCompatibleProvider(provider, config, modelId)
    if (typeof fallback.textEmbeddingModel !== "function") {
        throw new Error(`${provider.name} 不提供向量模型`)
    }
    return fallback.textEmbeddingModel(modelId) as EmbeddingModel
}

async function instantiateProvider(
    provider: ProviderDefinition,
    config: ProviderRuntimeConfig,
    modelId: string,
): Promise<ProviderInstance> {
    const baseURL = resolveBaseUrl(provider, config.baseUrl) ?? undefined
    const apiKey = config.apiKey
    const headers = Object.keys(config.headers).length > 0 ? config.headers : undefined
    const customFetch = createQuirkFetch({ providerKey: provider.key, modelId, options: config.quirks })
    const shared = { apiKey, baseURL, headers, ...(customFetch ? { fetch: customFetch } : {}) }

    switch (provider.sdk) {
        case "openai": {
            const { createOpenAI } = await import("@ai-sdk/openai")
            return createOpenAI(shared) as ProviderInstance
        }
        case "anthropic": {
            const { createAnthropic } = await import("@ai-sdk/anthropic")
            return createAnthropic(shared) as ProviderInstance
        }
        case "google": {
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
            return createGoogleGenerativeAI(shared) as ProviderInstance
        }
        case "google-vertex": {
            const { createVertex } = await import("@ai-sdk/google-vertex")
            return createVertex({
                project: requireExtra(config, provider, "project"),
                location: requireExtra(config, provider, "location"),
                // google-auth-library 的 credentials 用 snake_case 字段名
                googleAuthOptions: {
                    credentials: {
                        client_email: requireExtra(config, provider, "clientEmail"),
                        private_key: requireExtra(config, provider, "privateKey"),
                    },
                },
                ...(baseURL ? { baseURL } : {}),
                ...(headers ? { headers } : {}),
            }) as ProviderInstance
        }
        case "azure": {
            const { createAzure } = await import("@ai-sdk/azure")
            const apiVersion = config.extra.apiVersion?.trim()
            return createAzure({
                apiKey,
                ...(baseURL ? { baseURL } : { resourceName: requireExtra(config, provider, "resourceName") }),
                ...(apiVersion ? { apiVersion } : {}),
                ...(headers ? { headers } : {}),
            }) as ProviderInstance
        }
        case "amazon-bedrock": {
            const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
            const sessionToken = config.extra.sessionToken?.trim()
            return createAmazonBedrock({
                region: requireExtra(config, provider, "region"),
                accessKeyId: requireExtra(config, provider, "accessKeyId"),
                secretAccessKey: requireExtra(config, provider, "secretAccessKey"),
                ...(sessionToken ? { sessionToken } : {}),
                ...(baseURL ? { baseURL } : {}),
                ...(headers ? { headers } : {}),
            }) as ProviderInstance
        }
        case "xai": {
            const { createXai } = await import("@ai-sdk/xai")
            return createXai(shared) as ProviderInstance
        }
        case "mistral": {
            const { createMistral } = await import("@ai-sdk/mistral")
            return createMistral(shared) as ProviderInstance
        }
        case "cohere": {
            const { createCohere } = await import("@ai-sdk/cohere")
            return createCohere(shared) as ProviderInstance
        }
        case "groq": {
            const { createGroq } = await import("@ai-sdk/groq")
            return createGroq(shared) as ProviderInstance
        }
        case "cerebras": {
            const { createCerebras } = await import("@ai-sdk/cerebras")
            return createCerebras(shared) as ProviderInstance
        }
        case "deepseek": {
            const { createDeepSeek } = await import("@ai-sdk/deepseek")
            return createDeepSeek(shared) as ProviderInstance
        }
        case "deepinfra": {
            const { createDeepInfra } = await import("@ai-sdk/deepinfra")
            return createDeepInfra(shared) as ProviderInstance
        }
        case "togetherai": {
            const { createTogetherAI } = await import("@ai-sdk/togetherai")
            return createTogetherAI(shared) as ProviderInstance
        }
        case "fireworks": {
            const { createFireworks } = await import("@ai-sdk/fireworks")
            return createFireworks(shared) as ProviderInstance
        }
        case "perplexity": {
            const { createPerplexity } = await import("@ai-sdk/perplexity")
            return createPerplexity(shared) as ProviderInstance
        }
        case "baseten": {
            const { createBaseten } = await import("@ai-sdk/baseten")
            return createBaseten(shared) as ProviderInstance
        }
        case "huggingface": {
            const { createHuggingFace } = await import("@ai-sdk/huggingface")
            return createHuggingFace(shared) as ProviderInstance
        }
        case "moonshotai": {
            const { createMoonshotAI } = await import("@ai-sdk/moonshotai")
            return createMoonshotAI(shared) as ProviderInstance
        }
        case "alibaba": {
            const { createAlibaba } = await import("@ai-sdk/alibaba")
            return createAlibaba(shared) as ProviderInstance
        }
        case "minimax": {
            const { createMiniMax } = await import("@ai-sdk/minimax")
            return createMiniMax(shared) as ProviderInstance
        }
        case "voyage": {
            const { createVoyage } = await import("@ai-sdk/voyage")
            return createVoyage(shared) as ProviderInstance
        }
        case "gateway": {
            const { createGateway } = await import("@ai-sdk/gateway")
            return createGateway(shared) as ProviderInstance
        }
        case "openai-compatible":
            return createCompatibleProvider(provider, config, modelId)
    }
}

async function createCompatibleProvider(
    provider: ProviderDefinition,
    config: ProviderRuntimeConfig,
    modelId: string,
): Promise<ProviderInstance> {
    const baseURL = resolveBaseUrl(provider, config.baseUrl)
    if (!baseURL) {
        throw new Error(`${provider.name} 必须填写 BaseUrl`)
    }
    const customFetch = createQuirkFetch({ providerKey: provider.key, modelId, options: config.quirks })
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
    return createOpenAICompatible({
        name: provider.key,
        baseURL,
        apiKey: config.apiKey,
        ...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
        ...(customFetch ? { fetch: customFetch } : {}),
    }) as ProviderInstance
}

function requireExtra(config: ProviderRuntimeConfig, provider: ProviderDefinition, key: string): string {
    const value = config.extra[key]?.trim()
    if (!value) {
        const field = provider.credentialFields.find((item) => item.key === key)
        throw new Error(`${provider.name} 缺少必填凭证字段：${field?.label ?? key}`)
    }
    return value
}
