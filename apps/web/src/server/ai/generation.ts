import { asc, and, eq } from "drizzle-orm"
import { createOpenAI } from "@ai-sdk/openai"
import { getDb } from "@/server/db/client"
import { aiModelConfigs } from "@/server/db/schema"
import { decodeApiKey, type AiProtocol } from "@/server/ai/config-logic"
import {
    isDeepSeekProtocolContext,
    prepareDeepSeekChatBody,
    resolveChatProtocolAdapter,
    type ChatGenerationOptions,
    type DeepSeekThinkingMode,
    type ProtocolAdapterContext,
} from "@/server/ai/protocol-adapters"
import { badRequest, notFound } from "@/server/http/response"

export interface ChatCompletionMessage {
    role: "system" | "user" | "assistant"
    content: string
}

const SUPPORTED_CHAT_PROTOCOLS: AiProtocol[] = ["OPENAI", "DEEPSEEK", "OPENAI_COMPAT", "SILICONFLOW"]

export async function callChatCompletion(input: {
    userId: number
    configId?: number | null
    systemPrompt?: string | null
    message?: string
    messages?: ChatCompletionMessage[]
}) {
    const config = await resolveChatConfig(input.userId, input.configId ?? null)
    const apiKey = decodeApiKey(config.apiKeyEnc)
    if (!apiKey) {
        throw badRequest("CHAT 配置缺少 API Key")
    }
    if (config.protocol === "GEMINI") {
        throw badRequest("GEMINI 协议已禁用，请使用 OPENAI / DEEPSEEK / OPENAI_COMPAT / SILICONFLOW")
    }
    if (!SUPPORTED_CHAT_PROTOCOLS.includes(config.protocol as AiProtocol)) {
        throw badRequest("协议类型不能为空")
    }

    const baseUrl = config.baseUrl?.trim().replace(/\/+$/, "")
    if (!baseUrl) {
        throw badRequest("BaseUrl 不能为空")
    }
    if (!config.model.trim()) {
        throw badRequest("模型名称不能为空")
    }

    const options = parseChatGenerationOptions(config.extraJson)
    const adapter = resolveChatProtocolAdapter({
        protocol: config.protocol as AiProtocol,
        baseUrl,
        model: config.model,
        name: config.name,
        options,
    })

    const messages = input.messages?.length
        ? input.messages.map((message) => ({ role: message.role, content: message.content }))
        : [
            ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
            { role: "user" as const, content: input.message ?? "" },
        ]

    const requestBody = adapter.prepareChatBody({
        messages,
        model: config.model,
        ...(options.maxTokens == null ? {} : { max_tokens: options.maxTokens }),
        ...(options.temperature == null ? {} : { temperature: options.temperature }),
        stream: false,
    })

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
        throw badRequest(`调用 Chat 接口失败：HTTP ${response.status}`)
    }

    const data = await response.json() as {
        model?: string
        choices?: Array<{
            message?: {
                content?: string
                reasoning_content?: string
                reasoning?: string
            }
        }>
        usage?: {
            completion_tokens?: number
            prompt_tokens?: number
            total_tokens?: number
        }
    }
    const message = data.choices?.[0]?.message
    return {
        config,
        answer: message?.content?.trim() ?? "",
        modelName: data.model ?? config.model,
        reasoning: adapter.extractReasoning(message),
        usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
            totalTokens: data.usage?.total_tokens ?? 0,
        },
    }
}

export async function createChatLanguageModel(input: {
    userId: number
    configId?: number | null
}) {
    const config = await resolveChatConfig(input.userId, input.configId ?? null)
    const apiKey = decodeApiKey(config.apiKeyEnc)
    if (!apiKey) {
        throw badRequest("CHAT 配置缺少 API Key")
    }
    const baseURL = config.baseUrl?.trim().replace(/\/+$/, "")
    if (!baseURL) {
        throw badRequest("BaseUrl 不能为空")
    }
    const options = parseChatGenerationOptions(config.extraJson)
    const adapter = resolveChatProtocolAdapter({
        protocol: config.protocol as AiProtocol,
        baseUrl: baseURL,
        model: config.model,
        name: config.name,
        options,
    })
    const compatibleFetch = adapter.createFetch()
    const provider = createOpenAI({
        apiKey,
        baseURL,
        name: config.protocol.toLowerCase(),
        ...(compatibleFetch ? { fetch: compatibleFetch } : {}),
    })
    return {
        config,
        model: provider.chat(config.model),
    }
}

export async function resolveChatConfig(userId: number, configId: number | null) {
    if (configId != null) {
        const [config] = await getDb()
            .select()
            .from(aiModelConfigs)
            .where(and(eq(aiModelConfigs.id, configId), eq(aiModelConfigs.userId, userId)))
            .limit(1)
        if (!config) {
            throw notFound("CHAT 配置不存在")
        }
        if (config.configType !== "CHAT") {
            throw badRequest("配置类型不是 CHAT")
        }
        if (!config.enabled) {
            throw badRequest("CHAT 配置未启用")
        }
        return config
    }

    const [config] = await getDb()
        .select()
        .from(aiModelConfigs)
        .where(and(
            eq(aiModelConfigs.userId, userId),
            eq(aiModelConfigs.configType, "CHAT"),
            eq(aiModelConfigs.isDefault, true),
            eq(aiModelConfigs.enabled, true),
        ))
        .orderBy(asc(aiModelConfigs.id))
        .limit(1)

    if (!config) {
        throw badRequest("未找到可用的默认配置：CHAT")
    }
    return config
}

function parseChatGenerationOptions(extraJson: string | null | undefined): ChatGenerationOptions {
    const parsed = parseOptionalJsonObject(extraJson)
    const deepSeek = isRecord(parsed?.deepseek) ? parsed.deepseek : null
    return {
        maxTokens: positiveIntegerOrNull(parsed?.maxTokens ?? parsed?.max_tokens),
        temperature: numberOrNull(parsed?.temperature),
        deepSeekThinking: normalizeDeepSeekThinking(
            parsed?.deepSeekThinking
            ?? parsed?.deepseekThinking
            ?? deepSeek?.thinking
            ?? parsed?.thinking,
        ),
        disableDeepSeekThinkingForTools: booleanOrDefault(
            parsed?.disableDeepSeekThinkingForTools
            ?? parsed?.deepSeekDisableThinkingForTools
            ?? deepSeek?.disableThinkingForTools,
            true,
        ),
    }
}

export function resolveModelContextWindow(input: {
    model: string
    extraJson?: string | null
}): number {
    const parsed = parseOptionalJsonObject(input.extraJson)
    const override = positiveIntegerOrNull(parsed?.contextWindow ?? parsed?.context_window)
    if (override != null) return override

    const model = input.model.toLowerCase()
    // Anthropic Claude
    if (model.includes("claude-3.7") || model.includes("claude-4") || model.includes("claude-3.5") || model.includes("claude-3-")) return 200_000
    if (model.startsWith("claude-")) return 200_000
    // Gemini
    if (model.includes("gemini-2") || model.includes("gemini-1.5-pro")) return 2_000_000
    if (model.includes("gemini-1.5")) return 1_000_000
    if (model.includes("gemini")) return 1_000_000
    // DeepSeek
    // 参考 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    // 当前在售：deepseek-v4-flash / deepseek-v4-pro 均为 1M 上下文（最大输出 384K）
    // deepseek-chat / deepseek-reasoner 现为 v4-flash 的非思考/思考别名，同为 1M
    if (model.includes("deepseek-v4") || model.includes("deepseek-v5")) return 1_000_000
    if (model === "deepseek-chat" || model.startsWith("deepseek-chat-")) return 1_000_000
    if (model === "deepseek-reasoner" || model.startsWith("deepseek-reasoner-")) return 1_000_000
    // 历史模型保留兼容（部分代理仍在提供）：v3 / r1 为 64k，其余按 128k 兜底
    if (model.includes("deepseek-r1") || model.includes("deepseek-v3")) return 64_000
    if (model.includes("deepseek")) return 128_000
    // Qwen
    // 通义千问 3.6 系列（含 flash）：1M 上下文
    if (model.includes("qwen3.6") || model.includes("qwen-3.6")) return 1_000_000
    if (model.includes("qwen3") || model.includes("qwen-3") || model.includes("qwen-max") || model.includes("qwen-plus")) return 128_000
    if (model.includes("qwen2.5") || model.includes("qwen-2.5")) return 128_000
    if (model.includes("qwen")) return 32_000
    // GLM / Zhipu
    if (model.includes("glm-5")) return 200_000
    if (model.includes("glm-4")) return 128_000
    // Moonshot / Kimi
    if (model.includes("moonshot-128k") || model.includes("kimi-k2") || model.includes("kimi")) return 128_000
    if (model.includes("moonshot")) return 32_000
    // OpenAI
    if (model.includes("gpt-4.1") || model.includes("gpt-4o") || model.includes("gpt-4-turbo") || model.includes("o1") || model.includes("o3") || model.includes("o4")) return 128_000
    if (model.includes("gpt-3.5-turbo-16k") || model.includes("gpt-3.5-turbo-1106") || model.includes("gpt-3.5-turbo-0125")) return 16_385
    if (model.includes("gpt-3.5")) return 4_096
    if (model.includes("gpt-4")) return 8_192

    return 128_000
}

function parseOptionalJsonObject(raw: string | null | undefined) {
    const text = raw?.trim()
    if (!text) {
        return null
    }
    try {
        const parsed = JSON.parse(text) as unknown
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

/**
 * @deprecated 直接用 `resolveChatProtocolAdapter` 配合 protocol === "DEEPSEEK" 判定。
 * 保留导出仅为兼容旧测试。
 */
export function isDeepSeekOpenAICompatibleConfig(input: {
    baseURL: string
    model: string
    name: string
    protocol: string
}) {
    const protocol = input.protocol.trim().toUpperCase() as AiProtocol
    return isDeepSeekProtocolContext({
        protocol,
        baseUrl: input.baseURL,
        model: input.model,
        name: input.name,
        options: {
            maxTokens: null,
            temperature: null,
            deepSeekThinking: null,
            disableDeepSeekThinkingForTools: true,
        },
    })
}

/**
 * @deprecated 直接调用 `resolveChatProtocolAdapter(...).prepareChatBody(body)`。
 * 保留导出仅为兼容旧测试。
 */
export function prepareOpenAICompatibleChatBodyForProvider(input: {
    body: unknown
    context: {
        isDeepSeekProvider: boolean
        deepSeekThinking: DeepSeekThinkingMode | null
        disableDeepSeekThinkingForTools: boolean
    }
}) {
    if (!input.context.isDeepSeekProvider) {
        return input.body
    }
    return prepareDeepSeekChatBody(input.body, {
        maxTokens: null,
        temperature: null,
        deepSeekThinking: input.context.deepSeekThinking,
        disableDeepSeekThinkingForTools: input.context.disableDeepSeekThinkingForTools,
    })
}

function normalizeDeepSeekThinking(value: unknown): DeepSeekThinkingMode | null {
    if (isRecord(value)) {
        return normalizeDeepSeekThinking(value.type)
    }
    if (typeof value === "boolean") {
        return value ? "enabled" : "disabled"
    }
    const text = typeof value === "string" ? value.trim().toLowerCase() : ""
    return text === "enabled" || text === "disabled" ? text : null
}

function booleanOrDefault(value: unknown, defaultValue: boolean) {
    if (typeof value === "boolean") {
        return value
    }
    if (typeof value === "string") {
        const text = value.trim().toLowerCase()
        if (["true", "1", "yes", "on"].includes(text)) {
            return true
        }
        if (["false", "0", "no", "off"].includes(text)) {
            return false
        }
    }
    return defaultValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveIntegerOrNull(value: unknown) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function numberOrNull(value: unknown) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

export type { ProtocolAdapterContext }
