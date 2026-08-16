/**
 * 在线拉取供应商模型列表。
 *
 * new-api 的「获取模型列表」按钮做的就是这件事：拿渠道已填的 BaseUrl + Key 去打
 * `/models`，把返回的模型名回填到渠道配置里，用户不用手输。这里按供应商的
 * listing 模式分派不同的请求形状和解析函数，拉不到时回落到内置清单。
 */

import {
    catalogModelsOf,
    findCatalogModel,
    guessContextWindow,
    guessModelKind,
    type ModelListingMode,
    type ProviderDefinition,
    type ProviderModelKind,
} from "@/server/ai/provider-catalog"

export interface DiscoveredModel {
    id: string
    kind: ProviderModelKind
    label: string | null
    contextWindow: number
    /** 是否来自内置清单（在线接口没返回它） */
    preset: boolean
}

export interface ModelDiscoveryResult {
    models: DiscoveredModel[]
    /** 在线接口是否成功 */
    fetched: boolean
    /** 在线接口失败时的原因，成功时为 null */
    warning: string | null
}

export interface ModelDiscoveryInput {
    provider: ProviderDefinition
    baseUrl: string | null
    apiKey: string
    /** 供应商额外凭证字段（Bedrock region 等） */
    extra?: Record<string, string>
    headers?: Record<string, string>
    signal?: AbortSignal
}

const REQUEST_TIMEOUT_MS = 15_000

/**
 * 拉取模型列表。永远不抛异常：在线失败时退回内置清单并带上 warning，
 * 让用户仍然可以手动勾选预置模型继续配置。
 */
export async function discoverProviderModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
    const presets = toPresetModels(input.provider)

    if (input.provider.listing === "none") {
        return {
            models: presets,
            fetched: false,
            warning: `${input.provider.name} 没有公开的模型列表接口，已列出内置模型，可直接勾选或手动添加。`,
        }
    }

    try {
        const ids = await fetchModelIds(input)
        if (ids.length === 0) {
            return {
                models: presets,
                fetched: false,
                warning: "接口返回的模型列表为空，已回退到内置模型清单。",
            }
        }
        return { models: mergeWithPresets(input.provider, ids, presets), fetched: true, warning: null }
    } catch (error) {
        return {
            models: presets,
            fetched: false,
            warning: `${describeError(error)}，已回退到内置模型清单。`,
        }
    }
}

async function fetchModelIds(input: ModelDiscoveryInput): Promise<string[]> {
    const { provider, apiKey } = input
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    if (!baseUrl) {
        throw new Error("缺少 BaseUrl，无法拉取模型列表")
    }
    if (!apiKey.trim()) {
        throw new Error("缺少 API Key，无法拉取模型列表")
    }

    const request = buildListingRequest(provider.listing, baseUrl, apiKey)
    const response = await fetchWithTimeout(request.url, {
        method: "GET",
        headers: { ...request.headers, ...input.headers },
        signal: input.signal,
    })

    if (!response.ok) {
        throw new Error(`模型列表接口返回 HTTP ${response.status}${await readErrorHint(response)}`)
    }

    const payload = await response.json() as unknown
    return parseModelIds(provider.listing, payload)
}

/** 各 listing 模式的请求形状 */
export function buildListingRequest(mode: ModelListingMode, baseUrl: string, apiKey: string): {
    url: string
    headers: Record<string, string>
} {
    if (mode === "anthropic") {
        return {
            url: `${baseUrl}/models?limit=1000`,
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
        }
    }
    if (mode === "google") {
        // Gemini 用 query 参数带 key，且分页 pageSize 上限 1000
        return {
            url: `${baseUrl}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
            headers: {},
        }
    }
    if (mode === "cohere") {
        return {
            url: `${baseUrl.replace(/\/v2$/, "/v1")}/models?page_size=1000`,
            headers: { Authorization: `Bearer ${apiKey}` },
        }
    }
    return {
        url: `${baseUrl}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
    }
}

/** 各 listing 模式的响应解析。导出以便单测覆盖真实响应形状。 */
export function parseModelIds(mode: ModelListingMode, payload: unknown): string[] {
    if (!isRecord(payload)) return []

    if (mode === "google") {
        // { models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: [...] }] }
        const models = Array.isArray(payload.models) ? payload.models : []
        return dedupe(models
            .map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : ""))
            .map((name) => name.replace(/^models\//, ""))
            .filter(Boolean))
    }

    if (mode === "cohere") {
        // { models: [{ name: "command-a-03-2025", endpoints: ["chat"] }] }
        const models = Array.isArray(payload.models) ? payload.models : []
        return dedupe(models
            .map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : ""))
            .filter(Boolean))
    }

    // anthropic 与 openai 兼容端点都是 { data: [{ id }] }
    const data = Array.isArray(payload.data) ? payload.data : []
    return dedupe(data
        .map((entry) => {
            if (typeof entry === "string") return entry
            if (isRecord(entry) && typeof entry.id === "string") return entry.id
            return ""
        })
        .filter(Boolean))
}

/**
 * 在线结果与内置清单合并：
 * 在线拿到的 id 为准（补上内置清单里的元信息），内置清单里在线没返回的追加在后面，
 * 这样像 Anthropic 这种列表接口不返回全部别名的情况也不会丢模型。
 */
export function mergeWithPresets(
    provider: ProviderDefinition,
    ids: string[],
    presets: DiscoveredModel[],
): DiscoveredModel[] {
    const seen = new Set<string>()
    const merged: DiscoveredModel[] = []

    for (const id of ids) {
        const value = id.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        const catalog = findCatalogModel(provider, value)
        merged.push({
            id: value,
            kind: catalog?.kind ?? guessModelKind(value),
            label: catalog?.label ?? null,
            contextWindow: catalog?.contextWindow ?? guessContextWindow(value),
            preset: false,
        })
    }

    for (const preset of presets) {
        if (seen.has(preset.id)) continue
        seen.add(preset.id)
        merged.push(preset)
    }

    return merged
}

function toPresetModels(provider: ProviderDefinition): DiscoveredModel[] {
    return catalogModelsOf(provider).map((model) => ({
        id: model.id,
        kind: model.kind,
        label: model.label ?? null,
        contextWindow: model.contextWindow ?? guessContextWindow(model.id),
        preset: true,
    }))
}

function normalizeBaseUrl(baseUrl: string | null | undefined): string | null {
    const value = String(baseUrl ?? "").trim().replace(/\/+$/, "")
    return value || null
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const external = init.signal
    const onAbort = () => controller.abort()
    external?.addEventListener("abort", onAbort)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
        external?.removeEventListener("abort", onAbort)
    }
}

async function readErrorHint(response: Response): Promise<string> {
    try {
        const text = (await response.text()).trim()
        return text ? `（${text.slice(0, 160)}）` : ""
    } catch {
        return ""
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") {
            return "拉取模型列表超时"
        }
        return error.message
    }
    return "拉取模型列表失败"
}

function dedupe(values: string[]): string[] {
    return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
