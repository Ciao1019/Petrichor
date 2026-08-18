/**
 * 外部搜索提供方（§37/§38）。
 *
 * 站内此前没有任何联网检索能力，这里补上一层可插拔适配：
 * 通过环境变量选择 provider；未配置时明确返回 not_configured，
 * 让 Agent 优雅降级去用站内知识，而不是编造外部结论（§141）。
 */

export type WebSearchResult = {
    title: string
    url: string
    snippet: string
    /** 来源站点 */
    site: string
    publishedAt?: string
}

export type WebSearchResponse = {
    ok: boolean
    provider: string
    results: WebSearchResult[]
    errorCode?: "not_configured" | "provider_error" | "timeout"
    message?: string
}

export type WebSearchOptions = {
    maxResults?: number
    /** 限定站点，如 redis.io */
    site?: string
    /** 只要最近 N 天的结果 */
    recentDays?: number
    signal?: AbortSignal
    timeoutMs?: number
}

export type SearchProviderConfig = {
    provider: string
    apiKey?: string
    baseUrl?: string
    timeoutMs: number
}

export function resolveSearchProviderConfig(): SearchProviderConfig {
    return {
        provider: (process.env.RESEARCH_SEARCH_PROVIDER ?? "").trim().toLowerCase(),
        ...(process.env.RESEARCH_SEARCH_API_KEY ? { apiKey: process.env.RESEARCH_SEARCH_API_KEY } : {}),
        ...(process.env.RESEARCH_SEARCH_BASE_URL ? { baseUrl: process.env.RESEARCH_SEARCH_BASE_URL } : {}),
        timeoutMs: Number(process.env.RESEARCH_SEARCH_TIMEOUT_MS ?? 12_000),
    }
}

export async function webSearch(
    query: string,
    options: WebSearchOptions = {},
    config: SearchProviderConfig = resolveSearchProviderConfig(),
): Promise<WebSearchResponse> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 8, 1), 20)
    const finalQuery = options.site ? `site:${options.site} ${query}` : query

    if (!config.provider) {
        return {
            ok: false,
            provider: "none",
            results: [],
            errorCode: "not_configured",
            message: "未配置外部搜索服务（RESEARCH_SEARCH_PROVIDER）。请基于站内资料作答，或告知用户无法联网检索。",
        }
    }

    try {
        switch (config.provider) {
            case "tavily":
                return await searchTavily(finalQuery, maxResults, options, config)
            case "serper":
                return await searchSerper(finalQuery, maxResults, options, config)
            case "brave":
                return await searchBrave(finalQuery, maxResults, options, config)
            case "searxng":
                return await searchSearxng(finalQuery, maxResults, options, config)
            default:
                return {
                    ok: false,
                    provider: config.provider,
                    results: [],
                    errorCode: "not_configured",
                    message: `不支持的搜索服务：${config.provider}`,
                }
        }
    } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError"
        return {
            ok: false,
            provider: config.provider,
            results: [],
            errorCode: aborted ? "timeout" : "provider_error",
            message: error instanceof Error ? error.message : String(error),
        }
    }
}

async function requestJson(
    url: string,
    init: RequestInit,
    options: WebSearchOptions,
    config: SearchProviderConfig,
): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs)
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true })
    try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`)
        return await response.json()
    } finally {
        clearTimeout(timer)
    }
}

async function searchTavily(query: string, maxResults: number, options: WebSearchOptions, config: SearchProviderConfig) {
    const payload = await requestJson(
        `${config.baseUrl ?? "https://api.tavily.com"}/search`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                api_key: config.apiKey,
                query,
                max_results: maxResults,
                search_depth: "advanced",
                ...(options.recentDays ? { days: options.recentDays } : {}),
            }),
        },
        options,
        config,
    ) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> }

    return normalize("tavily", (payload.results ?? []).map((item) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        snippet: item.content ?? "",
        publishedAt: item.published_date,
    })))
}

async function searchSerper(query: string, maxResults: number, options: WebSearchOptions, config: SearchProviderConfig) {
    const payload = await requestJson(
        `${config.baseUrl ?? "https://google.serper.dev"}/search`,
        {
            method: "POST",
            headers: { "content-type": "application/json", "X-API-KEY": config.apiKey ?? "" },
            body: JSON.stringify({ q: query, num: maxResults }),
        },
        options,
        config,
    ) as { organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }> }

    return normalize("serper", (payload.organic ?? []).map((item) => ({
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.snippet ?? "",
        publishedAt: item.date,
    })))
}

async function searchBrave(query: string, maxResults: number, options: WebSearchOptions, config: SearchProviderConfig) {
    const url = new URL(`${config.baseUrl ?? "https://api.search.brave.com"}/res/v1/web/search`)
    url.searchParams.set("q", query)
    url.searchParams.set("count", String(maxResults))
    const payload = await requestJson(
        url.toString(),
        { headers: { accept: "application/json", "X-Subscription-Token": config.apiKey ?? "" } },
        options,
        config,
    ) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } }

    return normalize("brave", (payload.web?.results ?? []).map((item) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        snippet: item.description ?? "",
        publishedAt: item.age,
    })))
}

async function searchSearxng(query: string, maxResults: number, options: WebSearchOptions, config: SearchProviderConfig) {
    if (!config.baseUrl) throw new Error("SearXNG 需要 RESEARCH_SEARCH_BASE_URL")
    const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/search`)
    url.searchParams.set("q", query)
    url.searchParams.set("format", "json")
    const payload = await requestJson(url.toString(), {}, options, config) as {
        results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>
    }

    return normalize("searxng", (payload.results ?? []).slice(0, maxResults).map((item) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        snippet: item.content ?? "",
        publishedAt: item.publishedDate,
    })))
}

function normalize(
    provider: string,
    items: Array<{ title: string; url: string; snippet: string; publishedAt?: string }>,
): WebSearchResponse {
    const results: WebSearchResult[] = []
    const seen = new Set<string>()
    for (const item of items) {
        if (!item.url || !item.title) continue
        const site = safeHost(item.url)
        if (seen.has(item.url)) continue
        seen.add(item.url)
        results.push({
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            site,
            ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        })
    }
    return { ok: results.length > 0, provider, results }
}

export function safeHost(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "")
    } catch {
        return ""
    }
}
