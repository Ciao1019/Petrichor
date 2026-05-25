import type { AiProtocol } from "@/server/ai/config-logic"

export type DeepSeekThinkingMode = "enabled" | "disabled"

export interface ChatGenerationOptions {
    maxTokens: number | null
    temperature: number | null
    deepSeekThinking: DeepSeekThinkingMode | null
    disableDeepSeekThinkingForTools: boolean
}

export interface ChatCompletionResponseMessage {
    content?: string
    reasoning_content?: string
    reasoning?: string
}

export interface ProtocolAdapterContext {
    protocol: AiProtocol
    baseUrl: string
    model: string
    name: string
    options: ChatGenerationOptions
}

export interface ChatProtocolAdapter {
    readonly protocol: AiProtocol
    prepareChatBody(body: unknown): unknown
    createFetch(): typeof fetch | undefined
    extractReasoning(message: ChatCompletionResponseMessage | undefined): string | null
}

export function resolveChatProtocolAdapter(context: ProtocolAdapterContext): ChatProtocolAdapter {
    const protocol = context.protocol
    if (protocol === "DEEPSEEK") {
        return createDeepSeekAdapter(context)
    }
    if (protocol === "OPENAI") {
        return createOpenAIAdapter(context)
    }
    // OPENAI_COMPAT / SILICONFLOW：默认走通用 OpenAI 兼容，
    // 但对历史上以 DeepSeek 模型 / api.deepseek.com 接入的旧配置保留兼容。
    if (isLegacyDeepSeekCompatibleConfig(context)) {
        return createDeepSeekAdapter(context)
    }
    return createOpenAICompatAdapter(context)
}

function createDeepSeekAdapter(context: ProtocolAdapterContext): ChatProtocolAdapter {
    return {
        protocol: context.protocol,
        prepareChatBody(body) {
            return prepareDeepSeekChatBody(body, context.options)
        },
        createFetch() {
            return createDeepSeekFetch(context.options)
        },
        extractReasoning(message) {
            return optionalTrim(message?.reasoning_content ?? message?.reasoning)
        },
    }
}

function createOpenAIAdapter(context: ProtocolAdapterContext): ChatProtocolAdapter {
    return {
        protocol: context.protocol,
        prepareChatBody(body) {
            return body
        },
        createFetch() {
            return undefined
        },
        extractReasoning(message) {
            // OpenAI 标准响应通常没有顶层 reasoning_content；只在 o-series 时把 reasoning 透传。
            return optionalTrim(message?.reasoning)
        },
    }
}

function createOpenAICompatAdapter(context: ProtocolAdapterContext): ChatProtocolAdapter {
    return {
        protocol: context.protocol,
        prepareChatBody(body) {
            return body
        },
        createFetch() {
            return undefined
        },
        extractReasoning(message) {
            // 通用兼容协议：reasoning_content / reasoning 都尝试透出，但不做 thinking 注入。
            return optionalTrim(message?.reasoning_content ?? message?.reasoning)
        },
    }
}

export function prepareDeepSeekChatBody(body: unknown, options: ChatGenerationOptions) {
    if (!isRecord(body)) {
        return body
    }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const thinking = hasTools && options.disableDeepSeekThinkingForTools
        ? "disabled"
        : options.deepSeekThinking

    if (!thinking) {
        return body
    }

    // DeepSeek 思考模式结合工具调用时，下一轮请求必须回传 reasoning_content。
    // AI SDK OpenAI 兼容 provider 不会保留该私有字段，因此工具请求默认关闭 thinking。
    return {
        ...body,
        thinking: { type: thinking },
    }
}

function createDeepSeekFetch(options: ChatGenerationOptions): typeof fetch {
    return async (resource, init) => {
        if (!init?.body || !isChatCompletionsRequest(resource)) {
            return fetch(resource, init)
        }
        const body = parseFetchJsonBody(init.body)
        const nextBody = prepareDeepSeekChatBody(body, options)
        if (nextBody === body) {
            return fetch(resource, init)
        }
        return fetch(resource, {
            ...init,
            body: JSON.stringify(nextBody),
        })
    }
}

/**
 * 历史上 DEEPSEEK 协议尚不存在时，用户会用 OPENAI_COMPAT/OPENAI 接 api.deepseek.com 或
 * 使用 SILICONFLOW 的 deepseek-ai/* 模型。新协议落地后这种配置仍需正确触发 DeepSeek 适配。
 */
function isLegacyDeepSeekCompatibleConfig(context: ProtocolAdapterContext) {
    const protocol = context.protocol
    if (!["OPENAI", "OPENAI_COMPAT"].includes(protocol)) {
        return false
    }
    const baseUrl = context.baseUrl.toLowerCase()
    if (baseUrl.includes("api.deepseek.com") || baseUrl.includes("deepseek.com")) {
        return true
    }
    const descriptor = `${context.model} ${context.name}`.toLowerCase()
    return descriptor.includes("deepseek")
}

export function isDeepSeekProtocolContext(context: ProtocolAdapterContext) {
    if (context.protocol === "DEEPSEEK") return true
    return isLegacyDeepSeekCompatibleConfig(context)
}

function isChatCompletionsRequest(resource: Parameters<typeof fetch>[0]) {
    const url = getFetchUrl(resource)
    return url.includes("/chat/completions")
}

function getFetchUrl(resource: Parameters<typeof fetch>[0]) {
    if (typeof resource === "string") {
        return resource
    }
    if (resource instanceof URL) {
        return resource.toString()
    }
    if (typeof Request !== "undefined" && resource instanceof Request) {
        return resource.url
    }
    return ""
}

function parseFetchJsonBody(body: BodyInit) {
    if (typeof body !== "string") {
        return null
    }
    try {
        return JSON.parse(body) as unknown
    } catch {
        return null
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalTrim(value: string | null | undefined) {
    const text = value?.trim()
    return text || null
}
