import { embed, embedMany } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { aiModelConfigs } from "@/server/db/schema"
import { decodeApiKey } from "@/server/ai/config-logic"
import { resolveChatConfig } from "@/server/ai/generation"
import { badRequest } from "@/server/http/response"

export const EMBEDDING_DIMENSIONS = 1024

async function createEmbeddingModel(userId: number) {
    const config = await resolveChatConfig(userId, null, "EMBEDDING")
    const apiKey = decodeApiKey(config.apiKeyEnc)
    if (!apiKey) {
        throw badRequest("EMBEDDING 配置缺少 API Key")
    }
    const baseURL = config.baseUrl?.trim().replace(/\/+$/, "")
    if (!baseURL) {
        throw badRequest("EMBEDDING 配置缺少 BaseUrl")
    }
    const provider = createOpenAI({
        apiKey,
        baseURL,
        name: config.protocol.toLowerCase(),
    })
    return provider.textEmbeddingModel(config.model)
}

export async function embedTexts(userId: number, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
        return []
    }
    const model = await createEmbeddingModel(userId)
    const { embeddings } = await embedMany({ model, values: texts })
    return embeddings
}

export async function embedQuery(userId: number, query: string): Promise<number[]> {
    const model = await createEmbeddingModel(userId)
    const { embedding } = await embed({ model, value: query })
    return embedding
}

export async function hasEmbeddingConfig(userId: number): Promise<boolean> {
    const [config] = await getDb()
        .select({ id: aiModelConfigs.id })
        .from(aiModelConfigs)
        .where(and(
            eq(aiModelConfigs.userId, userId),
            eq(aiModelConfigs.configType, "EMBEDDING"),
            eq(aiModelConfigs.isDefault, true),
            eq(aiModelConfigs.enabled, true),
        ))
        .limit(1)
    return Boolean(config)
}
