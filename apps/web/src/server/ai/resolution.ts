/**
 * 用途 → 可调用模型 的解析层。
 *
 * 业务代码只说「我要 CHAT 模型」，由这里查出绑定的模型、它所属的供应商实例
 * 和凭证，拼成 `ProviderRuntimeConfig` 交给模型工厂。
 */

import { and, eq } from "drizzle-orm"
import type { EmbeddingModel, LanguageModel } from "ai"
import { getDb } from "@/server/db/client"
import {
    aiBindings,
    aiCredentials,
    aiModels,
    aiProviders,
    type AiCredentialRecord,
    type AiModelRecord,
    type AiProviderRecord,
} from "@/server/db/schema"
import { badRequest } from "@/server/http/response"
import {
    decodeApiKey,
    decodeExtra,
    parseGenerationOptions,
    parseStringMap,
    providerApiProtocol,
    PURPOSE_MODEL_KIND,
    type AiPurpose,
    type GenerationOptions,
} from "@/server/ai/config-logic"
import { findProvider } from "@/server/ai/provider-catalog"
import {
    createLanguageModel,
    createTextEmbeddingModel,
    type ProviderRuntimeConfig,
} from "@/server/ai/model-factory"

export interface ResolvedModel {
    model: AiModelRecord
    provider: AiProviderRecord
    credential: AiCredentialRecord
    options: GenerationOptions
    runtime: ProviderRuntimeConfig
}

const PURPOSE_LABEL: Record<AiPurpose, string> = {
    CHAT: "对话",
    VISION: "多模态",
    DOC_QA: "文档库问答",
    EMBEDDING: "向量嵌入",
}

/**
 * 解析某个用途当前绑定的模型。
 *
 * `modelRefId` 用于历史记录重放（assistant run / import job / review 上存的模型 id）：
 * 传了就优先用它，模型已被删除或停用时回落到用途绑定，避免历史任务因为改配置而报废。
 */
export async function resolveModelForPurpose(
    userId: number,
    purpose: AiPurpose,
    modelRefId?: number | null,
): Promise<ResolvedModel> {
    if (modelRefId != null) {
        const pinned = await loadResolvedModel(userId, modelRefId, purpose)
        if (pinned) return pinned
    }

    const [binding] = await getDb()
        .select()
        .from(aiBindings)
        .where(and(eq(aiBindings.userId, userId), eq(aiBindings.purpose, purpose)))
        .limit(1)

    if (!binding) {
        throw badRequest(
            `未配置${PURPOSE_LABEL[purpose]}模型，请前往「模型配置 → 用途绑定」为${PURPOSE_LABEL[purpose]}选择一个模型`,
        )
    }

    const resolved = await loadResolvedModel(userId, binding.modelRefId, purpose)
    if (!resolved) {
        throw badRequest(
            `${PURPOSE_LABEL[purpose]}绑定的模型已失效（模型或供应商被删除、停用），请重新绑定`,
        )
    }

    return { ...resolved, options: parseGenerationOptions(binding.optionsJson) }
}

/** 按模型主键装载完整链路；模型/供应商停用或类型不匹配时返回 null */
async function loadResolvedModel(
    userId: number,
    modelRefId: number,
    purpose: AiPurpose,
): Promise<ResolvedModel | null> {
    const [row] = await getDb()
        .select({
            model: aiModels,
            provider: aiProviders,
            credential: aiCredentials,
        })
        .from(aiModels)
        .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .innerJoin(aiCredentials, eq(aiCredentials.id, aiProviders.credentialId))
        .where(and(eq(aiModels.id, modelRefId), eq(aiModels.userId, userId)))
        .limit(1)

    if (!row || !row.model.enabled || !row.provider.enabled) {
        return null
    }
    if (row.model.kind !== PURPOSE_MODEL_KIND[purpose]) {
        return null
    }

    return {
        model: row.model,
        provider: row.provider,
        credential: row.credential,
        options: parseGenerationOptions(null),
        runtime: buildRuntimeConfig(row.provider, row.credential),
    }
}

/** 把供应商实例 + 凭证拼成模型工厂的入参 */
export function buildRuntimeConfig(
    provider: AiProviderRecord,
    credential: AiCredentialRecord,
    options?: GenerationOptions,
): ProviderRuntimeConfig {
    return {
        providerKey: provider.providerKey,
        baseUrl: provider.baseUrl,
        apiKey: decodeApiKey(credential.apiKeyEnc),
        extra: decodeExtra(credential.extraEnc),
        headers: parseStringMap(provider.headersJson),
        apiProtocol: providerApiProtocol(provider),
        quirks: {
            thinking: options?.thinking ?? null,
            disableThinkingForTools: options?.disableThinkingForTools ?? true,
        },
    }
}

/** 直接拿到某个用途可用的 LanguageModel */
export async function resolveLanguageModel(input: {
    userId: number
    purpose: AiPurpose
    modelRefId?: number | null
}): Promise<{ resolved: ResolvedModel; model: LanguageModel }> {
    const resolved = await resolveModelForPurpose(input.userId, input.purpose, input.modelRefId)
    const runtime = { ...resolved.runtime, quirks: toQuirks(resolved.options) }
    const model = await createLanguageModel(runtime, resolved.model.modelId)
    return { resolved, model }
}

/** 直接拿到 EMBEDDING 用途可用的向量模型 */
export async function resolveEmbeddingModel(userId: number): Promise<{
    resolved: ResolvedModel
    model: EmbeddingModel
}> {
    const resolved = await resolveModelForPurpose(userId, "EMBEDDING")
    const model = await createTextEmbeddingModel(resolved.runtime, resolved.model.modelId)
    return { resolved, model }
}

/** 某个用途是否已经绑定了可用模型（供 system 工具做能力自检） */
export async function hasUsableBinding(userId: number, purpose: AiPurpose): Promise<boolean> {
    const [row] = await getDb()
        .select({ id: aiModels.id })
        .from(aiBindings)
        .innerJoin(aiModels, eq(aiModels.id, aiBindings.modelRefId))
        .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .where(and(
            eq(aiBindings.userId, userId),
            eq(aiBindings.purpose, purpose),
            eq(aiModels.enabled, true),
            eq(aiProviders.enabled, true),
        ))
        .limit(1)
    return Boolean(row)
}

/** 该模型所属供应商在目录里的定义，用于取默认 BaseUrl 和 listing 能力 */
export function providerDefinitionOf(provider: AiProviderRecord) {
    return findProvider(provider.providerKey)
}

function toQuirks(options: GenerationOptions) {
    return {
        thinking: options.thinking,
        disableThinkingForTools: options.disableThinkingForTools,
    }
}
