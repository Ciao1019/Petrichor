import { and, desc, eq, gt, isNull, or } from "drizzle-orm"
import { z } from "zod"
import { isSuperAdmin } from "@/server/admin/logic"
import { toAgentApiKeyResponse } from "@/server/agent/api-key"
import {
    buildBindingResponse,
    buildModelResponse,
    encodeApiKey,
    parsePurpose,
    PURPOSE_MODEL_KIND,
} from "@/server/ai/config-logic"
import {
    SITE_APPEARANCE_ID,
    buildSiteAppearanceResponse,
} from "@/server/appearance/logic"
import { loadSiteAppearanceOrNull } from "@/server/appearance/public-loader"
import { getDb } from "@/server/db/client"
import { agentApiKeys, aiBindings, aiCredentials, aiModels, aiProviders, siteAppearance, users } from "@/server/db/schema"
import { badRequest, forbidden, notFound } from "@/server/http/response"
import { invalidatePublicSiteAppearanceCache } from "@/server/public-content-cache"
import type { AssistantToolContext, AssistantToolRegistration } from "../domain-types"

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const listAiModelsSchema = z.object({
    purpose: z.string().optional(),
})

const providerIdSchema = z.object({ providerId: idSchema })

const bindModelSchema = z.object({
    purpose: z.string(),
    modelRefId: idSchema,
})

const updateCredentialsSchema = z.object({
    credentialId: idSchema,
    apiKey: z.string().trim().min(1),
})

const revokeKeySchema = z.object({ apiKeyId: idSchema })

const setPublicQaSchema = z.object({
    enabled: z.boolean(),
})

async function findOwnedProvider(userId: number, providerId: number) {
    const [provider] = await getDb()
        .select()
        .from(aiProviders)
        .where(and(eq(aiProviders.id, providerId), eq(aiProviders.userId, userId)))
        .limit(1)
    if (!provider) throw notFound("供应商不存在")
    return provider
}

async function findOwnedCredential(userId: number, credentialId: number) {
    const [credential] = await getDb()
        .select()
        .from(aiCredentials)
        .where(and(eq(aiCredentials.id, credentialId), eq(aiCredentials.userId, userId)))
        .limit(1)
    if (!credential) throw notFound("凭证不存在")
    return credential
}

async function requireSuperAdmin(userId: number) {
    const [user] = await getDb()
        .select({ id: users.id, systemRole: users.systemRole })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    if (!user || !isSuperAdmin(user.systemRole, user.id)) {
        throw forbidden("仅超级管理员可执行该操作")
    }
}

export async function listAiModelsForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = listAiModelsSchema.parse(raw ?? {})
    const purpose = parsePurpose(input.purpose)
    const db = getDb()

    const filters = [eq(aiModels.userId, ctx.userId)]
    if (purpose) {
        filters.push(eq(aiModels.kind, PURPOSE_MODEL_KIND[purpose]))
    }
    const rows = await db
        .select({ model: aiModels, provider: aiProviders })
        .from(aiModels)
        .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .where(and(...filters))
        .orderBy(aiProviders.name, aiModels.modelId)
        .limit(100)

    const bindings = await db
        .select({ binding: aiBindings, model: aiModels, provider: aiProviders })
        .from(aiBindings)
        .leftJoin(aiModels, eq(aiModels.id, aiBindings.modelRefId))
        .leftJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .where(eq(aiBindings.userId, ctx.userId))

    return {
        purpose: purpose ?? null,
        models: rows.map((row) => buildModelResponse(row.model, { provider: row.provider })),
        bindings: bindings
            .filter((row) => purpose == null || row.binding.purpose === purpose)
            .map((row) => buildBindingResponse(row.binding, { model: row.model, provider: row.provider })),
    }
}

export async function listAgentApiKeysForAssistant(ctx: AssistantToolContext, _raw: unknown) {
    const now = new Date()
    const rows = await getDb()
        .select()
        .from(agentApiKeys)
        .where(and(
            eq(agentApiKeys.userId, ctx.userId),
            isNull(agentApiKeys.revokedAt),
            or(isNull(agentApiKeys.expiresAt), gt(agentApiKeys.expiresAt, now)),
        ))
        .orderBy(desc(agentApiKeys.createdAt), desc(agentApiKeys.id))
        .limit(50)
    return { items: rows.map(toAgentApiKeyResponse) }
}

export async function getPublicQaSettingForAssistant(_ctx: AssistantToolContext, _raw: unknown) {
    const record = await loadSiteAppearanceOrNull()
    const appearance = buildSiteAppearanceResponse(record)
    return { publicQaEnabled: appearance.publicQaEnabled }
}

export async function bindAiModelForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = bindModelSchema.parse(raw)
    const purpose = parsePurpose(input.purpose)
    if (!purpose) {
        throw badRequest("用途应为 CHAT / VISION / DOC_QA / EMBEDDING 之一")
    }

    const db = getDb()
    const [row] = await db
        .select({ model: aiModels, provider: aiProviders })
        .from(aiModels)
        .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .where(and(eq(aiModels.id, input.modelRefId), eq(aiModels.userId, ctx.userId)))
        .limit(1)
    if (!row) throw notFound("模型不存在")
    if (row.model.kind !== PURPOSE_MODEL_KIND[purpose]) {
        throw badRequest("模型类型与用途不匹配")
    }

    const [existing] = await db
        .select()
        .from(aiBindings)
        .where(and(eq(aiBindings.userId, ctx.userId), eq(aiBindings.purpose, purpose)))
        .limit(1)
    const values = { modelRefId: input.modelRefId, updatedAt: new Date() }
    const [saved] = existing
        ? await db.update(aiBindings).set(values).where(eq(aiBindings.id, existing.id)).returning()
        : await db.insert(aiBindings).values({ userId: ctx.userId, purpose, ...values }).returning()

    return buildBindingResponse(saved, { model: row.model, provider: row.provider })
}

export async function deleteAiProviderForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = providerIdSchema.parse(raw)
    await findOwnedProvider(ctx.userId, input.providerId)
    await getDb()
        .delete(aiProviders)
        .where(and(eq(aiProviders.id, input.providerId), eq(aiProviders.userId, ctx.userId)))
    return { providerId: String(input.providerId), deleted: true }
}

export async function updateAiCredentialForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = updateCredentialsSchema.parse(raw)
    const existing = await findOwnedCredential(ctx.userId, input.credentialId)
    const [updated] = await getDb()
        .update(aiCredentials)
        .set({ apiKeyEnc: encodeApiKey(input.apiKey), updatedAt: new Date() })
        .where(and(eq(aiCredentials.id, existing.id), eq(aiCredentials.userId, ctx.userId)))
        .returning()
    return {
        id: String(updated.id),
        name: updated.name,
        rotated: true,
    }
}

export async function revokeAgentApiKeyForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = revokeKeySchema.parse(raw)
    const now = new Date()
    const [record] = await getDb()
        .update(agentApiKeys)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(
            eq(agentApiKeys.id, input.apiKeyId),
            eq(agentApiKeys.userId, ctx.userId),
            isNull(agentApiKeys.revokedAt),
        ))
        .returning()
    if (!record) throw notFound("API Key 不存在")
    return { item: toAgentApiKeyResponse(record) }
}

export async function setPublicQaEnabledForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = setPublicQaSchema.parse(raw)
    await requireSuperAdmin(ctx.userId)
    const now = new Date()
    const [record] = await getDb()
        .insert(siteAppearance)
        .values({
            id: SITE_APPEARANCE_ID,
            publicQaEnabled: input.enabled,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: siteAppearance.id,
            set: {
                publicQaEnabled: input.enabled,
                updatedAt: now,
            },
        })
        .returning()
    invalidatePublicSiteAppearanceCache()
    return {
        publicQaEnabled: buildSiteAppearanceResponse(record).publicQaEnabled,
    }
}

const directDangerousGuard = async () => {
    throw badRequest("危险操作必须先通过 request_user_confirmation，不能直接调用")
}

function withConfirmGate(
    execute: (ctx: AssistantToolContext, input: unknown) => Promise<unknown>,
): (ctx: AssistantToolContext, input: unknown) => Promise<unknown> {
    return async (ctx, input) => {
        if ((ctx as AssistantToolContext & { __confirmExec?: boolean }).__confirmExec) {
            return await execute(ctx, input)
        }
        return await directDangerousGuard()
    }
}

export const adminAssistantTools: AssistantToolRegistration[] = [
    {
        name: "list_ai_models",
        domain: "admin",
        risk: "read",
        description: "列出当前用户已接入的 AI 模型与各用途的绑定情况（脱敏，不含 API Key）。",
        inputSchema: listAiModelsSchema,
        execute: listAiModelsForAssistant,
    },
    {
        name: "list_agent_api_keys",
        domain: "admin",
        risk: "read",
        description: "列出当前用户未吊销的 Agent API Key（仅前缀与元信息）。",
        inputSchema: z.object({}),
        execute: listAgentApiKeysForAssistant,
    },
    {
        name: "get_public_qa_setting",
        domain: "admin",
        risk: "read",
        description: "读取站点公开问答开关 publicQaEnabled。",
        inputSchema: z.object({}),
        execute: getPublicQaSettingForAssistant,
    },
    {
        name: "bind_ai_model",
        domain: "admin",
        risk: "write",
        description: "把指定模型绑定到某个用途（CHAT / VISION / DOC_QA / EMBEDDING）。",
        inputSchema: bindModelSchema,
        execute: bindAiModelForAssistant,
    },
    {
        name: "delete_ai_provider",
        domain: "admin",
        risk: "dangerous",
        description: "删除自有 AI 供应商及其下所有模型（危险：须经 request_user_confirmation）。",
        inputSchema: providerIdSchema,
        execute: withConfirmGate(deleteAiProviderForAssistant),
    },
    {
        name: "update_ai_credential",
        domain: "admin",
        risk: "dangerous",
        description: "轮换自有 AI 凭证的 API Key（危险：须经确认）。",
        inputSchema: updateCredentialsSchema,
        execute: withConfirmGate(updateAiCredentialForAssistant),
    },
    {
        name: "revoke_agent_api_key",
        domain: "admin",
        risk: "dangerous",
        description: "吊销自有 Agent API Key（危险：须经确认）。",
        inputSchema: revokeKeySchema,
        execute: withConfirmGate(revokeAgentApiKeyForAssistant),
    },
    {
        name: "set_public_qa_enabled",
        domain: "admin",
        risk: "dangerous",
        description: "设置站点公开问答开关（危险：须经确认；仅超级管理员）。",
        inputSchema: setPublicQaSchema,
        execute: withConfirmGate(setPublicQaEnabledForAssistant),
    },
]
