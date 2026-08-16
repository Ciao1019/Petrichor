import { embed, embedMany } from "ai"
import { eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { aiModels } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"
import {
    hasUsableBinding,
    resolveEmbeddingModel,
    resolveModelForPurpose,
    type ResolvedModel,
} from "@/server/ai/resolution"
import { createTextEmbeddingModel } from "@/server/ai/model-factory"
import type { ProviderRuntimeConfig } from "@/server/ai/model-factory"
import { ensureVectorIndexes, isValidDimensions } from "@/server/retrieval/vector-space"

/**
 * 向量维度不写死：由模型自己决定。
 *
 * 维度的来源有两条路径，都不需要用户手填：
 *   1. 主动探测：接入模型或绑定用途时调一次 `probeEmbeddingDimensions`，把结果写进 ai_model.dimensions；
 *   2. 被动自愈：真正 embed 时如果模型还没有记录维度，就从响应里学到并落库。
 *
 * 拿到维度后会顺带补齐该维度的 pgvector 部分索引（见 retrieval/vector-space）。
 */

/** embedding 元数据版本。改动分块或归一化策略时 +1，使历史向量整体失效重算。 */
export const EMBEDDING_VERSION = 1

export interface EmbeddingProfile {
    /** 绑定的模型主键，参与向量新鲜度判定，换模型即失效 */
    modelRefId: number
    model: string
    /**
     * 该模型的真实输出维度。null 表示还没探测过——
     * 此时不可能有用该模型写入的向量，按「一条都不匹配」处理即可。
     */
    dimensions: number | null
    version: number
    key: string
}

function buildProfile(resolved: ResolvedModel, dimensions: number | null): EmbeddingProfile {
    return {
        modelRefId: resolved.model.id,
        model: resolved.model.modelId,
        dimensions,
        version: EMBEDDING_VERSION,
        key: `${resolved.model.id}:${resolved.model.modelId}:${dimensions ?? "?"}:${EMBEDDING_VERSION}`,
    }
}

/**
 * 取当前 EMBEDDING 绑定的向量档案。
 *
 * 这是只读路径（面板状态、新鲜度判定都会调），**绝不发网络请求**：
 * 维度未知时返回 null，而不是现场探测。早期版本在这里探测，导致 Wiki 面板
 * 加载时会打一次真实 embed 请求，模型不可用就把整个面板拖垮。
 *
 * 维度的获得只发生在本来就要调模型的地方：绑定用途时的显式探测，
 * 以及 `embedTexts` / `embedQuery` 的写入与查询路径。
 */
export async function getEmbeddingProfile(userId: number): Promise<EmbeddingProfile> {
    // 只解析记录，不构造 SDK 实例，确保这条路径没有任何 I/O 可失败
    const resolved = await resolveModelForPurpose(userId, "EMBEDDING")
    const known = resolved.model.dimensions
    return buildProfile(resolved, isValidDimensions(known) ? known : null)
}

export async function embedTexts(userId: number, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
        return []
    }
    const { resolved, model } = await resolveEmbeddingModel(userId)
    const { embeddings } = await embedMany({ model, values: texts })
    if (embeddings.length === 0) {
        return []
    }

    const dimensions = await reconcileDimensions(resolved, embeddings[0].length)
    const mismatched = embeddings.find((embedding) => embedding.length !== dimensions)
    if (mismatched) {
        throw badRequest(`同一批向量维度不一致：期望 ${dimensions}，实际 ${mismatched.length}`)
    }
    return embeddings
}

export async function embedQuery(userId: number, query: string): Promise<number[]> {
    const { resolved, model } = await resolveEmbeddingModel(userId)
    const { embedding } = await embed({ model, value: query })
    await reconcileDimensions(resolved, embedding.length)
    return embedding
}

export async function hasEmbeddingConfig(userId: number): Promise<boolean> {
    return hasUsableBinding(userId, "EMBEDDING")
}

/**
 * 主动探测某个向量模型的输出维度：发一次最短的 embed 请求，量一下返回长度。
 * 这是唯一可靠的办法——各家 /models 接口都不返回维度。
 */
export async function probeEmbeddingDimensions(
    runtime: ProviderRuntimeConfig,
    modelId: string,
): Promise<number> {
    const model = await createTextEmbeddingModel(runtime, modelId)
    const { embedding } = await embed({ model, value: "dimension probe" })
    if (!isValidDimensions(embedding.length)) {
        throw badRequest(`模型返回的向量维度异常：${embedding.length}`)
    }
    return embedding.length
}

/**
 * 把探测到的维度写回模型记录，并补齐该维度的向量索引。
 * 返回最终生效的维度。
 */
export async function persistDimensions(modelRefId: number, dimensions: number): Promise<number> {
    if (!isValidDimensions(dimensions)) {
        throw badRequest(`模型返回的向量维度异常：${dimensions}`)
    }
    await getDb()
        .update(aiModels)
        .set({ dimensions, updatedAt: new Date() })
        .where(eq(aiModels.id, modelRefId))
    // 新维度首次出现时补建部分索引；已存在则是一次无开销的 if not exists
    await ensureVectorIndexes(dimensions)
    return dimensions
}

/**
 * 拿实际响应长度与模型记录上的维度对账。
 *
 * 记录为空 → 学习并落库；记录与实际不符 → 说明供应商换了模型实现（同名不同版本），
 * 以实际为准更新，历史向量会因为 embedding_dimensions 对不上而自动被判定为待重算。
 */
async function reconcileDimensions(resolved: ResolvedModel, actual: number): Promise<number> {
    if (resolved.model.dimensions === actual) {
        return actual
    }
    return persistDimensions(resolved.model.id, actual)
}
