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
    // SiliconFlow 上的 DeepSeek 模型同样不支持 json_schema，复用 DeepSeek 适配层。
    if (isLegacyDeepSeekCompatibleConfig(context) || isSiliconFlowDeepSeekModel(context)) {
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

/**
 * DeepSeek 拒绝 response_format.json_schema（generateObject / 结构化输出会 400）。
 * 降为 json_object，并把 schema 注入到 messages，满足「prompt 须含 json」约束。
 */
export function adaptUnsupportedJsonSchemaResponseFormat(body: unknown): unknown {
    if (!isRecord(body)) {
        return body
    }
    const responseFormat = body.response_format
    if (!isRecord(responseFormat) || responseFormat.type !== "json_schema") {
        return body
    }

    const jsonSchema = isRecord(responseFormat.json_schema) ? responseFormat.json_schema : null
    const schemaName = typeof jsonSchema?.name === "string" && jsonSchema.name.trim()
        ? jsonSchema.name.trim()
        : "response"
    const schema = jsonSchema?.schema

    const messages = Array.isArray(body.messages) ? [...body.messages] : []
    const instruction = [
        "Return ONLY a valid JSON object matching the required schema.",
        `Schema name: ${schemaName}.`,
        schema == null ? null : `JSON schema: ${JSON.stringify(schema)}`,
    ].filter(Boolean).join(" ")
    messages.push({ role: "user", content: instruction })

    return {
        ...body,
        messages,
        response_format: { type: "json_object" },
    }
}

export function prepareDeepSeekChatBody(body: unknown, options: ChatGenerationOptions) {
    const adapted = adaptUnsupportedJsonSchemaResponseFormat(body)
    if (!isRecord(adapted)) {
        return adapted
    }
    const hasTools = Array.isArray(adapted.tools) && adapted.tools.length > 0
    const thinking = hasTools && options.disableDeepSeekThinkingForTools
        ? "disabled"
        : options.deepSeekThinking

    if (!thinking) {
        return adapted
    }

    // DeepSeek 思考模式结合工具调用时，下一轮请求必须回传 reasoning_content。
    // AI SDK OpenAI 兼容 provider 不会保留该私有字段，因此工具请求默认关闭 thinking。
    return {
        ...adapted,
        thinking: { type: thinking },
    }
}

function createDeepSeekFetch(options: ChatGenerationOptions): typeof fetch {
    return async (resource, init) => {
        if (!init?.body || !isChatCompletionsRequest(resource)) {
            return fetch(resource, init)
        }
        const body = parseFetchJsonBody(init.body)
        if (body == null) {
            return fetch(resource, init)
        }
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

function isSiliconFlowDeepSeekModel(context: Pick<ProtocolAdapterContext, "protocol" | "model">) {
    return context.protocol === "SILICONFLOW" && context.model.toLowerCase().includes("deepseek")
}

export function isDeepSeekProtocolContext(context: ProtocolAdapterContext) {
    if (context.protocol === "DEEPSEEK") return true
    return isLegacyDeepSeekCompatibleConfig(context)
}

/**
 * DeepSeek（含兼容接入）不支持 OpenAI 的 response_format.json_schema。
 * Mastra 的 PromptInjectionDetector 等结构化检测需改走 jsonPromptInjection；
 * AI SDK generateObject 则由 DeepSeek fetch 适配层改写为 json_object。
 */
export function needsJsonPromptInjectionForStructuredOutput(context: Pick<ProtocolAdapterContext, "protocol" | "baseUrl" | "model" | "name">) {
    if (isDeepSeekProtocolContext({
        protocol: context.protocol,
        baseUrl: context.baseUrl,
        model: context.model,
        name: context.name,
        options: {
            maxTokens: null,
            temperature: null,
            deepSeekThinking: null,
            disableDeepSeekThinkingForTools: true,
        },
    })) {
        return true
    }
    return isSiliconFlowDeepSeekModel(context)
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
