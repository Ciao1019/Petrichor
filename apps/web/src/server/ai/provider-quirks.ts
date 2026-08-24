/**
 * 供应商怪癖适配层。
 *
 * 即使都自称「OpenAI 兼容」，各家在结构化输出、思考模式、推理字段上仍有差异。
 * 这里用一个 fetch 中间件在请求真正发出前改写 body，把差异挡在业务代码之外。
 */

export type ThinkingMode = "enabled" | "disabled"

export interface ProviderQuirkOptions {
    /** DeepSeek 系思考开关；null 表示不注入 */
    thinking: ThinkingMode | null
    /** 带 tools 的请求是否强制关闭思考（AI SDK 不回传 reasoning_content，开着会 400） */
    disableThinkingForTools: boolean
}

export const DEFAULT_QUIRK_OPTIONS: ProviderQuirkOptions = {
    thinking: null,
    disableThinkingForTools: true,
}

export type ProviderFetch = (
    resource: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>

interface ProviderQuirks {
    /** 不支持 response_format.json_schema，需要降级为 json_object 并把 schema 塞进 prompt */
    downgradeJsonSchema: boolean
    /** 支持 body.thinking 开关 */
    supportsThinkingFlag: boolean
}

const QUIRKS_BY_PROVIDER: Record<string, ProviderQuirks> = {
    deepseek: { downgradeJsonSchema: true, supportsThinkingFlag: true },
    // 硅基流动上的 DeepSeek 模型继承同样的限制，按模型名二次判定（见 resolveQuirks）
    siliconflow: { downgradeJsonSchema: false, supportsThinkingFlag: true },
}

const NO_QUIRKS: ProviderQuirks = { downgradeJsonSchema: false, supportsThinkingFlag: false }

export function resolveQuirks(providerKey: string, modelId: string): ProviderQuirks {
    const base = QUIRKS_BY_PROVIDER[providerKey] ?? NO_QUIRKS
    // 聚合平台上托管的 DeepSeek 模型同样拒绝 json_schema
    if (!base.downgradeJsonSchema && modelId.toLowerCase().includes("deepseek")) {
        return { ...base, downgradeJsonSchema: true, supportsThinkingFlag: true }
    }
    return base
}

export function needsQuirkFetch(providerKey: string, modelId: string): boolean {
    const quirks = resolveQuirks(providerKey, modelId)
    return quirks.downgradeJsonSchema || quirks.supportsThinkingFlag
}

/**
 * Mastra 的 PromptInjectionDetector 等内置处理器默认用 response_format.json_schema
 * 做结构化输出。对不支持它的供应商要改走 jsonPromptInjection，否则每轮都会 400。
 */
export function needsJsonPromptInjectionForStructuredOutput(providerKey: string, modelId: string): boolean {
    return resolveQuirks(providerKey, modelId).downgradeJsonSchema
}

/**
 * 构造带怪癖修正的 fetch。返回 undefined 表示该供应商不需要任何修正，
 * 调用方直接把 fetch 选项省略即可。
 */
export function createQuirkFetch(input: {
    providerKey: string
    modelId: string
    options?: Partial<ProviderQuirkOptions>
}): typeof fetch | undefined {
    const { providerKey, modelId } = input
    if (!needsQuirkFetch(providerKey, modelId)) {
        return undefined
    }
    const options: ProviderQuirkOptions = { ...DEFAULT_QUIRK_OPTIONS, ...input.options }
    const quirks = resolveQuirks(providerKey, modelId)

    return (async (resource, init) => {
        if (!init?.body || !isGenerationRequest(resource)) {
            return fetch(resource, init)
        }
        const body = parseJsonBody(init.body)
        if (body == null) {
            return fetch(resource, init)
        }
        const next = applyQuirks(body, quirks, options)
        if (next === body) {
            return fetch(resource, init)
        }
        return fetch(resource, { ...init, body: JSON.stringify(next) })
    }) as typeof fetch
}

export function applyQuirks(
    body: unknown,
    quirks: { downgradeJsonSchema: boolean; supportsThinkingFlag: boolean },
    options: ProviderQuirkOptions,
): unknown {
    let next = body
    if (quirks.downgradeJsonSchema) {
        next = downgradeJsonSchemaResponseFormat(next)
    }
    if (quirks.supportsThinkingFlag) {
        next = injectThinkingFlag(next, options)
    }
    return next
}

/**
 * DeepSeek 拒绝 response_format.json_schema（generateObject 会 400）。
 * 降级为 json_object，并把 schema 作为一条 user 消息注入，
 * 同时满足「prompt 必须包含 json 字样」的约束。
 */
export function downgradeJsonSchemaResponseFormat(body: unknown): unknown {
    if (!isRecord(body)) return body
    const responseFormat = body.response_format
    if (!isRecord(responseFormat) || responseFormat.type !== "json_schema") return body

    const jsonSchema = isRecord(responseFormat.json_schema) ? responseFormat.json_schema : null
    const schemaName = typeof jsonSchema?.name === "string" && jsonSchema.name.trim()
        ? jsonSchema.name.trim()
        : "response"
    const schema = jsonSchema?.schema

    const messages = Array.isArray(body.messages) ? [...body.messages] : []
    messages.push({
        role: "user",
        content: [
            "Return ONLY a valid JSON object matching the required schema.",
            `Schema name: ${schemaName}.`,
            schema == null ? null : `JSON schema: ${JSON.stringify(schema)}`,
        ].filter(Boolean).join(" "),
    })

    return { ...body, messages, response_format: { type: "json_object" } }
}

/** 注入 body.thinking，带 tools 时按配置强制关闭 */
export function injectThinkingFlag(body: unknown, options: ProviderQuirkOptions): unknown {
    if (!isRecord(body)) return body
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const thinking = hasTools && options.disableThinkingForTools ? "disabled" : options.thinking
    if (!thinking) return body
    return { ...body, thinking: { type: thinking } }
}

/** 从响应消息里抽推理内容，各家字段名不一 */
export function extractReasoning(message: { reasoning_content?: string; reasoning?: string } | undefined): string | null {
    const text = (message?.reasoning_content ?? message?.reasoning)?.trim()
    return text || null
}

/**
 * 生成类请求：两套协议都要拦。
 *
 * 只匹配 /chat/completions 会在供应商切到 Responses 协议后静默失效——
 * 请求照发，但 json_schema 降级和 thinking 注入都不会应用，
 * 表现为「换了个协议就开始 400」，很难排查。
 */
function isGenerationRequest(resource: Parameters<ProviderFetch>[0]): boolean {
    const url = getFetchUrl(resource)
    return url.includes("/chat/completions") || /\/responses(\?|$)/.test(url)
}

function getFetchUrl(resource: Parameters<ProviderFetch>[0]): string {
    if (typeof resource === "string") return resource
    if (resource instanceof URL) return resource.toString()
    if (typeof Request !== "undefined" && resource instanceof Request) return resource.url
    return ""
}

function parseJsonBody(body: BodyInit): unknown {
    if (typeof body !== "string") return null
    try {
        return JSON.parse(body) as unknown
    } catch {
        return null
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
