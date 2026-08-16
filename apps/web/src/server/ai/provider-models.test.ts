import { afterEach, describe, expect, it, vi } from "vitest"
import { requireProvider } from "./provider-catalog"
import {
    buildListingRequest,
    discoverProviderModels,
    mergeWithPresets,
    parseModelIds,
} from "./provider-models"

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("buildListingRequest", () => {
    it("OpenAI 兼容端点用 Bearer 鉴权", () => {
        const request = buildListingRequest("openai", "https://api.openai.com/v1", "sk-test")
        expect(request.url).toBe("https://api.openai.com/v1/models")
        expect(request.headers.Authorization).toBe("Bearer sk-test")
    })

    it("Anthropic 用 x-api-key 并带版本号", () => {
        const request = buildListingRequest("anthropic", "https://api.anthropic.com/v1", "sk-ant")
        expect(request.url).toContain("/models?limit=1000")
        expect(request.headers["x-api-key"]).toBe("sk-ant")
        expect(request.headers["anthropic-version"]).toBe("2023-06-01")
    })

    it("Gemini 把 key 放在 query 上并做 URL 编码", () => {
        const request = buildListingRequest("google", "https://x.test/v1beta", "key/with+chars")
        expect(request.url).toContain("key=key%2Fwith%2Bchars")
        expect(request.headers).toEqual({})
    })

    it("Cohere 的模型列表在 v1 而非 v2", () => {
        const request = buildListingRequest("cohere", "https://api.cohere.com/v2", "co-key")
        expect(request.url).toBe("https://api.cohere.com/v1/models?page_size=1000")
    })
})

describe("parseModelIds", () => {
    it("解析 OpenAI 形状并去重", () => {
        const ids = parseModelIds("openai", {
            data: [{ id: "gpt-5.2" }, { id: "gpt-4o" }, { id: "gpt-5.2" }],
        })
        expect(ids).toEqual(["gpt-5.2", "gpt-4o"])
    })

    it("解析 Gemini 形状并剥掉 models/ 前缀", () => {
        const ids = parseModelIds("google", {
            models: [{ name: "models/gemini-2.5-pro" }, { name: "models/text-embedding-004" }],
        })
        expect(ids).toEqual(["gemini-2.5-pro", "text-embedding-004"])
    })

    it("解析 Cohere 形状", () => {
        const ids = parseModelIds("cohere", {
            models: [{ name: "command-a-03-2025", endpoints: ["chat"] }, { name: "embed-v4.0" }],
        })
        expect(ids).toEqual(["command-a-03-2025", "embed-v4.0"])
    })

    it("面对畸形响应返回空数组而不是抛错", () => {
        expect(parseModelIds("openai", null)).toEqual([])
        expect(parseModelIds("openai", { data: "nope" })).toEqual([])
        expect(parseModelIds("openai", { data: [{ noId: 1 }] })).toEqual([])
        expect(parseModelIds("google", { models: [{}] })).toEqual([])
    })
})

describe("mergeWithPresets", () => {
    const openai = requireProvider("openai")
    const presets = [
        { id: "gpt-5.2", kind: "LANGUAGE" as const, label: null, contextWindow: 400_000, preset: true },
        { id: "text-embedding-3-large", kind: "EMBEDDING" as const, label: null, contextWindow: 128_000, preset: true },
    ]

    it("在线结果优先，并补齐内置清单里的元信息", () => {
        const merged = mergeWithPresets(openai, ["gpt-5.2", "o3-mini"], presets)
        expect(merged[0]).toMatchObject({ id: "gpt-5.2", preset: false, contextWindow: 400_000 })
        expect(merged[1]).toMatchObject({ id: "o3-mini", kind: "LANGUAGE", preset: false })
    })

    it("在线没返回的内置模型追加在后面且标记为 preset", () => {
        const merged = mergeWithPresets(openai, ["gpt-5.2"], presets)
        const embedding = merged.find((model) => model.id === "text-embedding-3-large")
        expect(embedding?.preset).toBe(true)
    })

    it("在线结果里的向量模型按命名推断类型", () => {
        const merged = mergeWithPresets(openai, ["text-embedding-3-small"], [])
        expect(merged[0].kind).toBe("EMBEDDING")
    })
})

describe("discoverProviderModels", () => {
    it("listing 为 none 时直接给内置清单并说明原因", async () => {
        const result = await discoverProviderModels({
            provider: requireProvider("perplexity"),
            baseUrl: "https://api.perplexity.ai",
            apiKey: "pk",
        })
        expect(result.fetched).toBe(false)
        expect(result.warning).toContain("没有公开的模型列表接口")
        expect(result.models.every((model) => model.preset)).toBe(true)
    })

    it("在线成功时返回接口结果", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(
            JSON.stringify({ data: [{ id: "gpt-4o" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
        )))
        const result = await discoverProviderModels({
            provider: requireProvider("openai"),
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
        })
        expect(result.fetched).toBe(true)
        expect(result.warning).toBeNull()
        expect(result.models[0].id).toBe("gpt-4o")
    })

    it("HTTP 失败时回退内置清单并带上原因，不抛异常", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })))
        const result = await discoverProviderModels({
            provider: requireProvider("openai"),
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-bad",
        })
        expect(result.fetched).toBe(false)
        expect(result.warning).toContain("401")
        expect(result.models.length).toBeGreaterThan(0)
    })

    it("缺少 API Key 时不发请求", async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
        const result = await discoverProviderModels({
            provider: requireProvider("openai"),
            baseUrl: "https://api.openai.com/v1",
            apiKey: "   ",
        })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(result.warning).toContain("缺少 API Key")
    })
})
