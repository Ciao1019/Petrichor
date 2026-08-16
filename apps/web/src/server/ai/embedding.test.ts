import { beforeEach, describe, expect, it, vi } from "vitest"

const aiMocks = vi.hoisted(() => ({
    embed: vi.fn(),
    embedMany: vi.fn(),
}))
vi.mock("ai", () => aiMocks)

const resolutionMocks = vi.hoisted(() => ({
    resolveModelForPurpose: vi.fn(),
    resolveEmbeddingModel: vi.fn(),
    hasUsableBinding: vi.fn(),
}))
vi.mock("@/server/ai/resolution", () => resolutionMocks)

const factoryMocks = vi.hoisted(() => ({ createTextEmbeddingModel: vi.fn() }))
vi.mock("@/server/ai/model-factory", () => factoryMocks)

const spaceMocks = vi.hoisted(() => ({
    ensureVectorIndexes: vi.fn(async () => ({ created: [], indexed: true })),
    isValidDimensions: (value: unknown) =>
        Number.isInteger(value) && (value as number) >= 8 && (value as number) <= 16_000,
}))
vi.mock("@/server/retrieval/vector-space", () => spaceMocks)

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }))
vi.mock("@/server/db/client", () => dbMocks)

import { embedQuery, embedTexts, getEmbeddingProfile } from "./embedding"

let updateChain: { set: ReturnType<typeof vi.fn>; where: ReturnType<typeof vi.fn> }

function mockUpdateChain() {
    const chain = {
        set: vi.fn(() => chain),
        where: vi.fn(async () => undefined),
    }
    dbMocks.getDb.mockReturnValue({ update: vi.fn(() => chain) })
    updateChain = chain
    return chain
}

/** 断言维度被写回 ai_model 记录，并补齐了该维度的向量索引 */
function expectPersistedDimensions(dimensions: number) {
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ dimensions }))
    expect(spaceMocks.ensureVectorIndexes).toHaveBeenCalledWith(dimensions)
}

function resolvedModel(dimensions: number | null) {
    return {
        model: { id: 42, modelId: "bge-m3", dimensions },
        provider: { id: 1, providerKey: "siliconflow" },
        credential: { id: 1 },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateChain()
})

describe("getEmbeddingProfile", () => {
    it("维度已知时直接返回，不碰网络", async () => {
        resolutionMocks.resolveModelForPurpose.mockResolvedValue(resolvedModel(1024))

        const profile = await getEmbeddingProfile(7)

        expect(profile.dimensions).toBe(1024)
        expect(profile.model).toBe("bge-m3")
        expect(profile.key).toContain("1024")
        expect(aiMocks.embed).not.toHaveBeenCalled()
    })

    /**
     * 回归防护：这条路径被 Wiki 面板等只读接口调用，
     * 早期版本会在维度未知时现场探测，导致模型不可用时整个面板报错。
     */
    it("维度未知时返回 null，绝不发探测请求", async () => {
        resolutionMocks.resolveModelForPurpose.mockResolvedValue(resolvedModel(null))

        const profile = await getEmbeddingProfile(7)

        expect(profile.dimensions).toBeNull()
        expect(aiMocks.embed).not.toHaveBeenCalled()
        expect(factoryMocks.createTextEmbeddingModel).not.toHaveBeenCalled()
        // 连 SDK 实例都不该构造
        expect(resolutionMocks.resolveEmbeddingModel).not.toHaveBeenCalled()
    })

    it("记录了非法维度时同样按未知处理", async () => {
        resolutionMocks.resolveModelForPurpose.mockResolvedValue(resolvedModel(0))
        expect((await getEmbeddingProfile(7)).dimensions).toBeNull()
    })
})

describe("embedTexts", () => {
    it("首次调用从响应学到维度并落库", async () => {
        resolutionMocks.resolveEmbeddingModel.mockResolvedValue({
            resolved: resolvedModel(null),
            model: {},
        })
        aiMocks.embedMany.mockResolvedValue({ embeddings: [new Array(768).fill(0.1)] })

        const result = await embedTexts(7, ["hello"])

        expect(result[0]).toHaveLength(768)
        expectPersistedDimensions(768)
    })

    it("同批次维度不一致时报错", async () => {
        resolutionMocks.resolveEmbeddingModel.mockResolvedValue({
            resolved: resolvedModel(768),
            model: {},
        })
        aiMocks.embedMany.mockResolvedValue({
            embeddings: [new Array(768).fill(0.1), new Array(1024).fill(0.1)],
        })

        await expect(embedTexts(7, ["a", "b"])).rejects.toThrow(/维度不一致/)
    })

    it("空输入直接返回，不调用模型", async () => {
        expect(await embedTexts(7, [])).toEqual([])
        expect(aiMocks.embedMany).not.toHaveBeenCalled()
    })
})

describe("embedQuery", () => {
    it("实际维度与记录不符时以实际为准更新", async () => {
        resolutionMocks.resolveEmbeddingModel.mockResolvedValue({
            resolved: resolvedModel(1024),
            model: {},
        })
        aiMocks.embed.mockResolvedValue({ embedding: new Array(768).fill(0.2) })

        const vector = await embedQuery(7, "q")

        expect(vector).toHaveLength(768)
        expectPersistedDimensions(768)
    })

    it("维度一致时不重复写库", async () => {
        resolutionMocks.resolveEmbeddingModel.mockResolvedValue({
            resolved: resolvedModel(1024),
            model: {},
        })
        aiMocks.embed.mockResolvedValue({ embedding: new Array(1024).fill(0.2) })

        await embedQuery(7, "q")

        expect(updateChain.set).not.toHaveBeenCalled()
        expect(spaceMocks.ensureVectorIndexes).not.toHaveBeenCalled()
    })
})
