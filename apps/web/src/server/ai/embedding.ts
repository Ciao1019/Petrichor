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

/**
 * 向量维度：模型侧动态探测，存储侧仍然固定。
 *
 * 模型的真实输出维度不写死，由两条路径得到，都不需要用户手填：
 *   1. 主动探测：接入模型或绑定用途时调一次 `probeEmbeddingDimensions`，把结果写进 ai_model.dimensions；
 *   2. 被动自愈：真正 embed 时如果模型还没有记录维度，就从响应里学到并落库。
 *
 * 但数据库里的向量列目前仍是 `vector(1024)`（见 full-migration），
 * 因此实际可写入的只有 STORAGE_DIMENSIONS 维的向量。探测出来的维度对不上时，
 * 写入会被 pgvector 拒绝——这里在探测阶段就把维度亮出来，让用户在绑定前发现。
 */

/** embedding 元数据版本。改动分块或归一化策略时 +1，使历史向量整体失效重算。 */
export const EMBEDDING_VERSION = 1

/** 数据库向量列声明的维度。换用其它维度的模型需要先迁移这些列。 */
export const STORAGE_DIMENSIONS = 1024

/**
 * @deprecated 用 `STORAGE_DIMENSIONS`。保留导出仅为兼容旧引用。
 */
export const EMBEDDING_DIMENSIONS = STORAGE_DIMENSIONS

/** 合法维度范围，用于校验探测结果 */
export const MIN_DIMENSIONS = 8
export const MAX_DIMENSIONS = 16_000

export function isValidDimensions(value: unknown): value is number {
    return Number.isInteger(value)
        && (value as number) >= MIN_DIMENSIONS
        && (value as number) <= MAX_DIMENSIONS
}

/** 探测到的维度能否直接存进现有向量列 */
export function isStorableDimensions(dimensions: number): boolean {
    return dimensions === STORAGE_DIMENSIONS
}

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
 * 把探测到的维度写回模型记录。返回最终生效的维度。
 */
export async function persistDimensions(modelRefId: number, dimensions: number): Promise<number> {
    if (!isValidDimensions(dimensions)) {
        throw badRequest(`模型返回的向量维度异常：${dimensions}`)
    }
    await getDb()
        .update(aiModels)
        .set({ dimensions, updatedAt: new Date() })
        .where(eq(aiModels.id, modelRefId))
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
