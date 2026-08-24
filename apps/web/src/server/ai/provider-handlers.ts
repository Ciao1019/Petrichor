/**
 * 供应商实例与模型接口。
 *
 * 核心交互（对齐 new-api 的渠道配置）：
 *   1. 选供应商 → 自动带出默认 BaseUrl
 *   2. 选一条凭证
 *   3. 点「获取模型列表」→ 打该供应商的 /models，把结果回填成可勾选清单
 *   4. 勾选要启用的模型 → 落库到 petrichor_ai_model
 */

import { and, count, desc, eq, inArray } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { aiBindings, aiCredentials, aiModels, aiProviders } from "@/server/db/schema"
import type { AiCredentialRecord, AiProviderRecord } from "@/server/db/schema"
import { getDb } from "@/server/db/client"
import { badRequest, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    buildModelResponse,
    buildProviderResponse,
    decodeApiKey,
    decodeExtra,
    parseStringMap,
    providerApiProtocol,
    requireId,
    validateModelInput,
    validateProviderInput,
} from "@/server/ai/config-logic"
import {
    findProvider,
    listCatalogSummaries,
    requireProvider,
    resolveApiProtocol,
    resolveBaseUrl,
    type ApiProtocol,
} from "@/server/ai/provider-catalog"
import { discoverProviderModels } from "@/server/ai/provider-models"
import { createLanguageModel } from "@/server/ai/model-factory"
import { persistDimensions, probeEmbeddingDimensions } from "@/server/ai/embedding"
import { buildRuntimeConfig } from "@/server/ai/resolution"
import { MAX_INDEXABLE_DIMENSIONS } from "@/server/retrieval/vector-space"
import { generateText } from "ai"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: AppRequest, handler: (user: User) => Promise<Response>) {
    try {
        return await handler(await requireCurrentUser(request))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

// ===== 供应商目录 =====

/** 静态目录，供前端渲染供应商选择器（默认 BaseUrl、额外凭证字段、预置模型） */
export async function listAiProviderCatalog(request: AppRequest) {
    return withUser(request, async () => ok({ items: listCatalogSummaries() }))
}

// ===== 供应商实例 CRUD =====

export async function listAiProviders(request: AppRequest) {
    return withUser(request, async (user) => {
        const db = getDb()
        const rows = await db
            .select({ provider: aiProviders, credential: aiCredentials })
            .from(aiProviders)
            .innerJoin(aiCredentials, eq(aiCredentials.id, aiProviders.credentialId))
            .where(eq(aiProviders.userId, user.id))
            .orderBy(desc(aiProviders.updatedAt), desc(aiProviders.id))

        const counts = await db
            .select({ providerId: aiModels.providerId, total: count() })
            .from(aiModels)
            .where(eq(aiModels.userId, user.id))
            .groupBy(aiModels.providerId)

        const enabledRows = await db
            .select({ providerId: aiModels.providerId, total: count() })
            .from(aiModels)
            .where(and(eq(aiModels.userId, user.id), eq(aiModels.enabled, true)))
            .groupBy(aiModels.providerId)

        const totalMap = new Map(counts.map((row) => [row.providerId, row.total]))
        const enabledMap = new Map(enabledRows.map((row) => [row.providerId, row.total]))

        return ok({
            items: rows.map((row) => buildProviderResponse(row.provider, {
                credential: row.credential,
                modelCount: totalMap.get(row.provider.id) ?? 0,
                enabledModelCount: enabledMap.get(row.provider.id) ?? 0,
            })),
        })
    })
}

export async function createAiProvider(request: AppRequest) {
    return withUser(request, async (user) => {
        const input = validateProviderInput(await readJson(request))
        await ensureCredentialOwned(user.id, input.credentialId)
        await ensureUniqueName(user.id, input.name)

        const [record] = await getDb()
            .insert(aiProviders)
            .values({
                userId: user.id,
                providerKey: input.providerKey,
                name: input.name,
                baseUrl: input.baseUrl,
                credentialId: input.credentialId,
                enabled: input.enabled,
                headersJson: JSON.stringify(input.headers),
                optionsJson: JSON.stringify(input.options),
            })
            .returning()
        return ok(buildProviderResponse(record))
    })
}

export async function updateAiProvider(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const id = requireId(raw.id, "供应商 ID")
        const existing = await findOwnedProvider(user.id, id)

        const input = validateProviderInput({
            providerKey: raw.providerKey ?? existing.providerKey,
            name: raw.name ?? existing.name,
            baseUrl: raw.baseUrl === undefined ? existing.baseUrl : raw.baseUrl,
            credentialId: raw.credentialId ?? existing.credentialId,
            enabled: raw.enabled ?? existing.enabled,
            headers: raw.headers === undefined ? existing.headersJson : raw.headers,
            options: raw.options === undefined ? existing.optionsJson : raw.options,
        })
        await ensureCredentialOwned(user.id, input.credentialId)
        if (input.name !== existing.name) {
            await ensureUniqueName(user.id, input.name, id)
        }

        const [updated] = await getDb()
            .update(aiProviders)
            .set({
                providerKey: input.providerKey,
                name: input.name,
                baseUrl: input.baseUrl,
                credentialId: input.credentialId,
                enabled: input.enabled,
                headersJson: JSON.stringify(input.headers),
                optionsJson: JSON.stringify(input.options),
                updatedAt: new Date(),
            })
            .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, user.id)))
            .returning()
        return ok(buildProviderResponse(updated))
    })
}

export async function deleteAiProvider(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const id = requireId(raw.id, "供应商 ID")
        await findOwnedProvider(user.id, id)

        // 模型随供应商级联删除，绑定又级联到模型，因此先提示占用情况
        const [bound] = await getDb()
            .select({ total: count() })
            .from(aiBindings)
            .innerJoin(aiModels, eq(aiModels.id, aiBindings.modelRefId))
            .where(and(eq(aiBindings.userId, user.id), eq(aiModels.providerId, id)))
        if ((bound?.total ?? 0) > 0) {
            throw badRequest(`该供应商下有 ${bound.total} 个模型正被用途绑定使用，请先改绑其它模型`)
        }

        await getDb().delete(aiProviders).where(and(eq(aiProviders.id, id), eq(aiProviders.userId, user.id)))
        return new Response(null, { status: 200 })
    })
}

// ===== 模型发现与同步 =====

/**
 * 拉取该供应商的可用模型列表。
 * 支持两种入参：已保存的供应商 id，或者「还没保存」的草稿（providerKey + baseUrl + credentialId），
 * 后者让用户在新建表单里就能点「获取模型列表」验证配置。
 */
export async function fetchAiProviderModels(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const context = await resolveDraftContext(user.id, raw)
        const provider = requireProvider(context.providerKey)

        const result = await discoverProviderModels({
            provider,
            baseUrl: resolveBaseUrl(provider, context.baseUrl),
            apiKey: context.apiKey,
            extra: context.extra,
            headers: context.headers,
        })

        // 已经保存过的模型标记出来，前端直接反映勾选态
        const saved = context.providerId == null
            ? []
            : await getDb()
                .select({
                    modelId: aiModels.modelId,
                    enabled: aiModels.enabled,
                    dimensions: aiModels.dimensions,
                })
                .from(aiModels)
                .where(eq(aiModels.providerId, context.providerId))
        const savedMap = new Map(saved.map((row) => [row.modelId, row]))

        return ok({
            fetched: result.fetched,
            warning: result.warning,
            items: result.models.map((model) => ({
                modelId: model.id,
                kind: model.kind,
                label: model.label,
                contextWindow: model.contextWindow,
                preset: model.preset,
                saved: savedMap.has(model.id),
                enabled: savedMap.get(model.id)?.enabled ?? false,
                // 维度只有探测过才有；/models 接口不返回这个信息
                dimensions: savedMap.get(model.id)?.dimensions ?? null,
            })),
        })
    })
}

/**
 * 把用户勾选的模型写入供应商。整体覆盖语义：
 * 传入列表之外的旧模型会被删除（被用途绑定引用的除外，避免绑定断链）。
 */
export async function syncAiProviderModels(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const providerId = requireId(raw.providerId, "供应商 ID")
        await findOwnedProvider(user.id, providerId)

        const items = Array.isArray(raw.models) ? raw.models : []
        const inputs = items.map((item) => validateModelInput(item))
        if (inputs.length === 0) {
            throw badRequest("请至少勾选一个模型")
        }

        const db = getDb()
        const existing = await db
            .select()
            .from(aiModels)
            .where(eq(aiModels.providerId, providerId))
        const existingMap = new Map(existing.map((row) => [row.modelId, row]))
        const keep = new Set(inputs.map((input) => input.modelId))

        // 被绑定引用的模型即使没勾选也保留，否则绑定会级联删除
        const boundIds = await db
            .select({ modelRefId: aiBindings.modelRefId })
            .from(aiBindings)
            .where(eq(aiBindings.userId, user.id))
        const boundSet = new Set(boundIds.map((row) => row.modelRefId))

        const removable = existing.filter((row) => !keep.has(row.modelId) && !boundSet.has(row.id))
        if (removable.length > 0) {
            await db.delete(aiModels).where(inArray(aiModels.id, removable.map((row) => row.id)))
        }

        for (const input of inputs) {
            const current = existingMap.get(input.modelId)
            if (current) {
                await db
                    .update(aiModels)
                    .set({
                        displayName: input.displayName,
                        kind: input.kind,
                        contextWindow: input.contextWindow,
                        capabilitiesJson: JSON.stringify(input.capabilities),
                        enabled: input.enabled,
                        updatedAt: new Date(),
                    })
                    .where(eq(aiModels.id, current.id))
                continue
            }
            await db.insert(aiModels).values({
                userId: user.id,
                providerId,
                modelId: input.modelId,
                displayName: input.displayName,
                kind: input.kind,
                contextWindow: input.contextWindow,
                capabilitiesJson: JSON.stringify(input.capabilities),
                enabled: input.enabled,
            })
        }

        const rows = await db
            .select()
            .from(aiModels)
            .where(eq(aiModels.providerId, providerId))
            .orderBy(aiModels.kind, aiModels.modelId)
        return ok({ items: rows.map((row) => buildModelResponse(row)) })
    })
}

/** 某个供应商下已保存的模型 */
export async function listAiModels(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const db = getDb()
        const filters = [eq(aiModels.userId, user.id)]
        if (raw.providerId != null) {
            filters.push(eq(aiModels.providerId, requireId(raw.providerId, "供应商 ID")))
        }
        const kind = typeof raw.kind === "string" ? raw.kind.trim() : ""
        if (kind === "LANGUAGE" || kind === "EMBEDDING") {
            filters.push(eq(aiModels.kind, kind))
        }
        if (raw.enabledOnly) {
            filters.push(eq(aiModels.enabled, true))
        }

        const rows = await db
            .select({ model: aiModels, provider: aiProviders })
            .from(aiModels)
            .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
            .where(and(...filters))
            .orderBy(aiProviders.name, aiModels.kind, aiModels.modelId)

        return ok({ items: rows.map((row) => buildModelResponse(row.model, { provider: row.provider })) })
    })
}

/**
 * 探测向量模型的输出维度。
 *
 * 各家的 /models 接口都不返回维度，唯一可靠的办法是发一次最短的 embed 请求量返回长度。
 * 结果写回模型记录，供绑定界面展示。
 */
export async function probeAiModelDimensions(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const id = requireId(raw.id, "模型 ID")

        const [row] = await getDb()
            .select({ model: aiModels, provider: aiProviders, credential: aiCredentials })
            .from(aiModels)
            .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
            .innerJoin(aiCredentials, eq(aiCredentials.id, aiProviders.credentialId))
            .where(and(eq(aiModels.id, id), eq(aiModels.userId, user.id)))
            .limit(1)
        if (!row) {
            throw notFound("模型不存在")
        }
        if (row.model.kind !== "EMBEDDING") {
            throw badRequest("只有向量模型需要探测维度")
        }

        try {
            const dimensions = await probeEmbeddingDimensions(
                buildRuntimeConfig(row.provider, row.credential),
                row.model.modelId,
            )
            await persistDimensions(row.model.id, dimensions)
            const indexable = dimensions <= MAX_INDEXABLE_DIMENSIONS
            return ok({
                id: String(row.model.id),
                modelId: row.model.modelId,
                dimensions,
                indexable,
                // 超过 HNSW 上限只是退化为顺扫，功能仍然正确，所以是提示不是错误
                warning: indexable
                    ? null
                    : `该模型输出 ${dimensions} 维，超过 pgvector HNSW 索引上限 ${MAX_INDEXABLE_DIMENSIONS}，检索会退化为顺序扫描`,
            })
        } catch (error) {
            throw badRequest(`探测维度失败：${error instanceof Error ? error.message : "调用失败"}`)
        }
    })
}

/** 单个模型的启用开关 */
export async function toggleAiModel(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const id = requireId(raw.id, "模型 ID")
        const enabled = Boolean(raw.enabled)

        const [updated] = await getDb()
            .update(aiModels)
            .set({ enabled, updatedAt: new Date() })
            .where(and(eq(aiModels.id, id), eq(aiModels.userId, user.id)))
            .returning()
        if (!updated) {
            throw notFound("模型不存在")
        }
        return ok(buildModelResponse(updated))
    })
}

// ===== 连通性测试 =====

/**
 * 用最小的一次真实调用验证配置是否可用，结果写回供应商记录。
 * 不消耗多少 token，但能一次性验出 Key、BaseUrl、模型名、鉴权方式是否都对。
 */
export async function testAiProvider(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const context = await resolveDraftContext(user.id, raw)
        const provider = requireProvider(context.providerKey)

        // 优先用调用方指定的模型；没指定时才回落到目录预置清单。
        // 多数聚合平台的预置清单是空的，这时必须让用户先拉列表再选，不能瞎猜一个模型名。
        const modelId = String(raw.modelId ?? "").trim()
            || provider.models.find((model) => model.kind === "LANGUAGE")?.id
            || ""
        if (!modelId) {
            throw badRequest(`${provider.name} 没有内置可用于测试的模型，请先点「获取模型列表」并选择一个测试用模型`)
        }

        const started = Date.now()
        try {
            const model = await createLanguageModel({
                providerKey: context.providerKey,
                baseUrl: context.baseUrl,
                apiKey: context.apiKey,
                extra: context.extra,
                headers: context.headers,
                apiProtocol: context.apiProtocol,
            }, modelId)
            const result = await generateText({
                model,
                prompt: "ping",
                maxOutputTokens: 16,
            })
            const latency = Date.now() - started
            const message = `连通正常，耗时 ${latency}ms`
            await recordCheck(context.providerId, "OK", message)
            return ok({
                status: "OK",
                latencyMs: latency,
                message,
                sample: result.text.trim().slice(0, 200),
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : "调用失败"
            await recordCheck(context.providerId, "FAILED", message.slice(0, 500))
            return ok({ status: "FAILED", latencyMs: Date.now() - started, message, sample: null })
        }
    })
}

async function recordCheck(providerId: number | null, status: string, message: string) {
    if (providerId == null) return
    await getDb()
        .update(aiProviders)
        .set({ lastCheckedAt: new Date(), lastCheckStatus: status, lastCheckMessage: message, updatedAt: new Date() })
        .where(eq(aiProviders.id, providerId))
}

// ===== 内部工具 =====

interface DraftContext {
    providerId: number | null
    providerKey: string
    baseUrl: string | null
    apiKey: string
    extra: Record<string, string>
    headers: Record<string, string>
    /** 连通性测试必须用真实调用时的协议，否则「测试通过、实际 404」 */
    apiProtocol: ApiProtocol
}

/**
 * 统一「已保存的供应商」和「新建表单里的草稿」两种入参。
 * 前者只需 id，后者需要 providerKey + credentialId（+ 可选 baseUrl / headers）。
 */
async function resolveDraftContext(userId: number, raw: Record<string, unknown>): Promise<DraftContext> {
    if (raw.id != null) {
        const providerId = requireId(raw.id, "供应商 ID")
        const record = await findOwnedProvider(userId, providerId)
        const credential = await loadCredential(userId, record.credentialId)
        return {
            providerId,
            providerKey: record.providerKey,
            // 允许前端在测试时临时覆盖 BaseUrl，方便调试代理地址
            baseUrl: raw.baseUrl === undefined ? record.baseUrl : normalizeOptionalUrl(raw.baseUrl),
            apiKey: decodeApiKey(credential.apiKeyEnc),
            extra: decodeExtra(credential.extraEnc),
            headers: parseStringMap(raw.headers === undefined ? record.headersJson : raw.headers),
            // 同样允许临时切协议，用来确认某个中转到底认哪套端点
            apiProtocol: resolveApiProtocol(
                requireProvider(record.providerKey),
                raw.apiProtocol === undefined ? providerApiProtocol(record) : String(raw.apiProtocol ?? ""),
            ),
        }
    }

    const providerKey = String(raw.providerKey ?? "").trim()
    const provider = findProvider(providerKey)
    if (!provider) {
        throw badRequest("请选择供应商")
    }
    const credential = await loadCredential(userId, requireId(raw.credentialId, "凭证 ID"))
    return {
        providerId: null,
        providerKey,
        baseUrl: normalizeOptionalUrl(raw.baseUrl),
        apiKey: decodeApiKey(credential.apiKeyEnc),
        extra: decodeExtra(credential.extraEnc),
        headers: parseStringMap(raw.headers),
        apiProtocol: resolveApiProtocol(provider, raw.apiProtocol as string | undefined),
    }
}

function normalizeOptionalUrl(raw: unknown): string | null {
    const value = String(raw ?? "").trim().replace(/\/+$/, "")
    return value || null
}

async function loadCredential(userId: number, credentialId: number): Promise<AiCredentialRecord> {
    const [record] = await getDb()
        .select()
        .from(aiCredentials)
        .where(and(eq(aiCredentials.id, credentialId), eq(aiCredentials.userId, userId)))
        .limit(1)
    if (!record) {
        throw notFound("凭证不存在")
    }
    return record
}

async function ensureCredentialOwned(userId: number, credentialId: number) {
    await loadCredential(userId, credentialId)
}

async function findOwnedProvider(userId: number, id: number): Promise<AiProviderRecord> {
    const [record] = await getDb()
        .select()
        .from(aiProviders)
        .where(and(eq(aiProviders.id, id), eq(aiProviders.userId, userId)))
        .limit(1)
    if (!record) {
        throw notFound("供应商不存在")
    }
    return record
}

async function ensureUniqueName(userId: number, name: string, excludeId?: number) {
    const rows = await getDb()
        .select({ id: aiProviders.id })
        .from(aiProviders)
        .where(and(eq(aiProviders.userId, userId), eq(aiProviders.name, name)))
        .limit(2)
    if (rows.some((row) => row.id !== excludeId)) {
        throw badRequest("已存在同名供应商，请换一个名称")
    }
}
