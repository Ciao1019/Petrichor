import { and, count, desc, eq, ilike } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { aiModelConfigs } from "@/server/db/schema"
import { getDb } from "@/server/db/client"
import { badRequest, notFound, ok, readJson, tableData, toErrorResponse } from "@/server/http/response"
import {
    applyDefaultBaseUrl,
    buildAiConfigResponse,
    encodeApiKey,
    optionalString,
    parseConfigType,
    parseProtocol,
    validateAiConfigCreateInput,
    validateAiConfigIdInput,
} from "./config-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function listAiConfigs(request: NextRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const pageNum = normalizePositiveInteger(raw.pageNum, 1)
        const pageSize = normalizePositiveInteger(raw.pageSize, 20)
        const filters = [eq(aiModelConfigs.userId, user.id), eq(aiModelConfigs.configType, "CHAT")]
        const configType = parseConfigType(raw.configType)
        const protocol = parseProtocol(raw.protocol)
        if (configType) {
            filters.push(eq(aiModelConfigs.configType, configType))
        }
        if (protocol) {
            filters.push(eq(aiModelConfigs.protocol, protocol))
        }
        if (raw.enabled != null) {
            filters.push(eq(aiModelConfigs.enabled, Boolean(raw.enabled)))
        }
        const keyword = String(raw.keyword ?? "").trim()
        if (keyword) {
            filters.push(ilike(aiModelConfigs.name, `%${keyword}%`))
        }

        const where = and(...filters)
        const [totalRow] = await getDb().select({ total: count() }).from(aiModelConfigs).where(where)
        const rows = await getDb()
            .select()
            .from(aiModelConfigs)
            .where(where)
            .orderBy(desc(aiModelConfigs.updatedAt), desc(aiModelConfigs.id))
            .limit(pageSize)
            .offset((pageNum - 1) * pageSize)
        return tableData(rows.map(buildAiConfigResponse), totalRow?.total ?? 0)
    })
}

export async function createAiConfig(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateAiConfigCreateInput(await readJson(request))
        await ensureUniqueName(user.id, input.configType, input.name)
        const db = getDb()
        if (input.isDefault) {
            await db
                .update(aiModelConfigs)
                .set({ isDefault: false, updatedAt: new Date() })
                .where(and(eq(aiModelConfigs.userId, user.id), eq(aiModelConfigs.configType, input.configType), eq(aiModelConfigs.isDefault, true)))
        }
        const [config] = await db
            .insert(aiModelConfigs)
            .values({
                userId: user.id,
                configType: input.configType,
                protocol: input.protocol,
                name: input.name,
                baseUrl: input.baseUrl,
                apiKeyEnc: input.apiKey ? encodeApiKey(input.apiKey) : null,
                model: input.model,
                enabled: input.enabled,
                isDefault: input.isDefault,
                extraJson: input.extraJson,
            })
            .returning()
        return ok(buildAiConfigResponse(config))
    })
}

export async function detailAiConfig(request: NextRequest) {
    return withUser(request, async (user) => {
        const { id } = validateAiConfigIdInput(await readJson(request))
        return ok(buildAiConfigResponse(await findOwnedConfig(user.id, id)))
    })
}

export async function updateAiConfig(request: NextRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const { id } = validateAiConfigIdInput(raw)
        const existing = await findOwnedConfig(user.id, id)

        const configType = raw.configType == null ? parseConfigType(existing.configType) : parseConfigType(raw.configType)
        const protocol = raw.protocol == null ? parseProtocol(existing.protocol) : parseProtocol(raw.protocol)
        if (!configType) {
            throw badRequest("配置类型不能为空")
        }
        if (!protocol) {
            throw badRequest("协议类型不能为空")
        }
        const name = raw.name == null ? existing.name : String(raw.name).trim()
        if (!name) {
            throw badRequest("配置名称不能为空")
        }
        const model = raw.model == null ? existing.model : String(raw.model).trim()
        if (!model) {
            throw badRequest("模型名称不能为空")
        }
        const baseUrl = raw.baseUrl == null ? existing.baseUrl : applyDefaultBaseUrl(protocol, optionalString(raw.baseUrl))
        if (protocol === "OPENAI_COMPAT" && !baseUrl) {
            throw badRequest("OPENAI_COMPAT 协议必须填写 BaseUrl")
        }
        const enabled = raw.enabled == null ? existing.enabled : Boolean(raw.enabled)
        const apiKeyEnc = raw.apiKey == null
            ? existing.apiKeyEnc
            : optionalString(raw.apiKey)
                ? encodeApiKey(String(raw.apiKey).trim())
                : null
        if (enabled && !apiKeyEnc) {
            throw badRequest("启用配置前必须填写 API Key")
        }
        if (configType !== existing.configType || name !== existing.name) {
            await ensureUniqueName(user.id, configType, name, id)
        }
        const isDefault = raw.isDefault == null ? existing.isDefault : Boolean(raw.isDefault)
        if (isDefault) {
            await getDb()
                .update(aiModelConfigs)
                .set({ isDefault: false, updatedAt: new Date() })
                .where(and(eq(aiModelConfigs.userId, user.id), eq(aiModelConfigs.configType, configType), eq(aiModelConfigs.isDefault, true)))
        }

        const [updated] = await getDb()
            .update(aiModelConfigs)
            .set({
                configType,
                protocol,
                name,
                baseUrl,
                apiKeyEnc,
                model,
                enabled,
                isDefault,
                extraJson: raw.extraJson == null ? existing.extraJson : optionalString(raw.extraJson),
                updatedAt: new Date(),
            })
            .where(and(eq(aiModelConfigs.id, id), eq(aiModelConfigs.userId, user.id)))
            .returning()

        return ok(buildAiConfigResponse(updated))
    })
}

export async function deleteAiConfig(request: NextRequest) {
    return withUser(request, async (user) => {
        const { id } = validateAiConfigIdInput(await readJson(request))
        await findOwnedConfig(user.id, id)
        await getDb().delete(aiModelConfigs).where(and(eq(aiModelConfigs.id, id), eq(aiModelConfigs.userId, user.id)))
        return new NextResponse(null, { status: 200 })
    })
}

export async function setDefaultAiConfig(request: NextRequest) {
    return withUser(request, async (user) => {
        const { id } = validateAiConfigIdInput(await readJson(request))
        const existing = await findOwnedConfig(user.id, id)
        await getDb()
            .update(aiModelConfigs)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(and(eq(aiModelConfigs.userId, user.id), eq(aiModelConfigs.configType, existing.configType), eq(aiModelConfigs.isDefault, true)))
        const [updated] = await getDb()
            .update(aiModelConfigs)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(and(eq(aiModelConfigs.id, id), eq(aiModelConfigs.userId, user.id)))
            .returning()
        return ok(buildAiConfigResponse(updated))
    })
}

async function findOwnedConfig(userId: number, id: number) {
    const [config] = await getDb()
        .select()
        .from(aiModelConfigs)
        .where(and(eq(aiModelConfigs.id, id), eq(aiModelConfigs.userId, userId)))
        .limit(1)
    if (!config) {
        throw notFound("配置不存在")
    }
    return config
}

async function ensureUniqueName(userId: number, configType: string, name: string, excludeId?: number) {
    const rows = await getDb()
        .select({ id: aiModelConfigs.id })
        .from(aiModelConfigs)
        .where(and(eq(aiModelConfigs.userId, userId), eq(aiModelConfigs.configType, configType), eq(aiModelConfigs.name, name)))
        .limit(2)
    if (rows.some((row) => row.id !== excludeId)) {
        throw badRequest("同类型下已存在同名配置")
    }
}

function normalizePositiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
