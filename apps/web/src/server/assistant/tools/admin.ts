import { and, desc, eq, gt, isNull, or } from "drizzle-orm"
import { z } from "zod"
import { isSuperAdmin } from "@/server/admin/logic"
import { toAgentApiKeyResponse } from "@/server/agent/api-key"
import { buildAiConfigResponse, encodeApiKey, parseConfigType } from "@/server/ai/config-logic"
import {
    SITE_APPEARANCE_ID,
    buildSiteAppearanceResponse,
} from "@/server/appearance/logic"
import { loadSiteAppearanceOrNull } from "@/server/appearance/public-loader"
import { getDb } from "@/server/db/client"
import { agentApiKeys, aiModelConfigs, siteAppearance, users } from "@/server/db/schema"
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

const listAiConfigsSchema = z.object({
    configType: z.string().optional(),
})

const configIdSchema = z.object({ configId: idSchema })

const updateCredentialsSchema = z.object({
    configId: idSchema,
    apiKey: z.string().trim().min(1),
    enabled: z.boolean().optional(),
})

const revokeKeySchema = z.object({ apiKeyId: idSchema })

const setPublicQaSchema = z.object({
    enabled: z.boolean(),
})

async function findOwnedAiConfig(userId: number, configId: number) {
    const [config] = await getDb()
        .select()
        .from(aiModelConfigs)
        .where(and(eq(aiModelConfigs.id, configId), eq(aiModelConfigs.userId, userId)))
        .limit(1)
    if (!config) throw notFound("配置不存在")
    return config
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

export async function listAiConfigsForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = listAiConfigsSchema.parse(raw ?? {})
    const configType = parseConfigType(input.configType) ?? "CHAT"
    const rows = await getDb()
        .select()
        .from(aiModelConfigs)
        .where(and(eq(aiModelConfigs.userId, ctx.userId), eq(aiModelConfigs.configType, configType)))
        .orderBy(desc(aiModelConfigs.isDefault), desc(aiModelConfigs.updatedAt), desc(aiModelConfigs.id))
        .limit(50)
    return {
        configType,
        items: rows.map(buildAiConfigResponse),
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

export async function setDefaultAiConfigForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = configIdSchema.parse(raw)
    const existing = await findOwnedAiConfig(ctx.userId, input.configId)
    const db = getDb()
    await db
        .update(aiModelConfigs)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(
            eq(aiModelConfigs.userId, ctx.userId),
            eq(aiModelConfigs.configType, existing.configType),
            eq(aiModelConfigs.isDefault, true),
        ))
    const [updated] = await db
        .update(aiModelConfigs)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(aiModelConfigs.id, existing.id), eq(aiModelConfigs.userId, ctx.userId)))
        .returning()
    return buildAiConfigResponse(updated)
}

export async function deleteAiConfigForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = configIdSchema.parse(raw)
    await findOwnedAiConfig(ctx.userId, input.configId)
    await getDb()
        .delete(aiModelConfigs)
        .where(and(eq(aiModelConfigs.id, input.configId), eq(aiModelConfigs.userId, ctx.userId)))
    return { configId: String(input.configId), deleted: true }
}

export async function updateAiConfigCredentialsForAssistant(ctx: AssistantToolContext, raw: unknown) {
    const input = updateCredentialsSchema.parse(raw)
    const existing = await findOwnedAiConfig(ctx.userId, input.configId)
    const enabled = input.enabled ?? existing.enabled
    const apiKeyEnc = encodeApiKey(input.apiKey)
    if (enabled && !apiKeyEnc) {
        throw badRequest("启用配置前必须填写 API Key")
    }
    const [updated] = await getDb()
        .update(aiModelConfigs)
        .set({
            apiKeyEnc,
            enabled,
            updatedAt: new Date(),
        })
        .where(and(eq(aiModelConfigs.id, existing.id), eq(aiModelConfigs.userId, ctx.userId)))
        .returning()
    return buildAiConfigResponse(updated)
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
        name: "list_ai_configs",
        domain: "admin",
        risk: "read",
        description: "列出当前用户的 AI 模型配置（脱敏，不含明文 API Key）。",
        inputSchema: listAiConfigsSchema,
        execute: listAiConfigsForAssistant,
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
        name: "set_default_ai_config",
        domain: "admin",
        risk: "write",
        description: "将指定 AI 配置设为同类型默认。",
        inputSchema: configIdSchema,
        execute: setDefaultAiConfigForAssistant,
    },
    {
        name: "delete_ai_config",
        domain: "admin",
        risk: "dangerous",
        description: "删除自有 AI 配置（危险：须经 request_user_confirmation）。",
        inputSchema: configIdSchema,
        execute: withConfirmGate(deleteAiConfigForAssistant),
    },
    {
        name: "update_ai_config_credentials",
        domain: "admin",
        risk: "dangerous",
        description: "更新自有 AI 配置的 API Key（危险：须经确认）。",
        inputSchema: updateCredentialsSchema,
        execute: withConfirmGate(updateAiConfigCredentialsForAssistant),
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
