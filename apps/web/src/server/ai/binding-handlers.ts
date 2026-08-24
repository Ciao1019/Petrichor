/**
 * 用途绑定接口。
 *
 * 替代旧的 configType + isDefault：四个用途（CHAT / VISION / DOC_QA / EMBEDDING）
 * 各绑定一个已启用的模型，并携带该用途独立的生成参数。
 */

import { and, eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { createLogger, toLogError } from "@/lib/logger"
import { requireCurrentUser } from "@/server/auth/current-user"
import { aiBindings, aiCredentials, aiModels, aiProviders } from "@/server/db/schema"
import { getDb } from "@/server/db/client"
import { badRequest, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import { persistDimensions, probeEmbeddingDimensions } from "@/server/ai/embedding"
import { buildRuntimeConfig } from "@/server/ai/resolution"
import {
    AI_PURPOSES,
    buildBindingResponse,
    parseGenerationOptions,
    PURPOSE_MODEL_KIND,
    requireId,
    requirePurpose,
} from "@/server/ai/config-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>
const log = createLogger("ai-binding-handler")

async function withUser(request: AppRequest, handler: (user: User) => Promise<Response>) {
    try {
        return await handler(await requireCurrentUser(request))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

/** 四个用途的当前绑定，未绑定的用途返回 null 占位，前端好画完整的四行 */
export async function listAiBindings(request: AppRequest) {
    return withUser(request, async (user) => {
        const rows = await getDb()
            .select({ binding: aiBindings, model: aiModels, provider: aiProviders })
            .from(aiBindings)
            .leftJoin(aiModels, eq(aiModels.id, aiBindings.modelRefId))
            .leftJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
            .where(eq(aiBindings.userId, user.id))

        const byPurpose = new Map(rows.map((row) => [
            row.binding.purpose,
            buildBindingResponse(row.binding, { model: row.model, provider: row.provider }),
        ]))

        return ok({
            items: AI_PURPOSES.map((purpose) => ({
                purpose,
                requiredKind: PURPOSE_MODEL_KIND[purpose],
                binding: byPurpose.get(purpose) ?? null,
            })),
        })
    })
}

/** 绑定或改绑某个用途（upsert 语义） */
export async function setAiBinding(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const purpose = requirePurpose(raw.purpose)
        const modelRefId = requireId(raw.modelRefId, "模型 ID")

        const [row] = await getDb()
            .select({ model: aiModels, provider: aiProviders, credential: aiCredentials })
            .from(aiModels)
            .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
            .innerJoin(aiCredentials, eq(aiCredentials.id, aiProviders.credentialId))
            .where(and(eq(aiModels.id, modelRefId), eq(aiModels.userId, user.id)))
            .limit(1)
        if (!row) {
            throw notFound("模型不存在")
        }
        if (!row.model.enabled) {
            throw badRequest("该模型已停用，请先在供应商下启用它")
        }
        if (!row.provider.enabled) {
            throw badRequest("该模型所属的供应商已停用")
        }
        const requiredKind = PURPOSE_MODEL_KIND[purpose]
        if (row.model.kind !== requiredKind) {
            throw badRequest(
                requiredKind === "EMBEDDING"
                    ? "向量嵌入用途只能绑定向量模型"
                    : "该用途只能绑定语言模型",
            )
        }

        const options = parseGenerationOptions(
            typeof raw.options === "object" && raw.options !== null
                ? raw.options as Record<string, unknown>
                : null,
        )

        const db = getDb()
        const [existing] = await db
            .select()
            .from(aiBindings)
            .where(and(eq(aiBindings.userId, user.id), eq(aiBindings.purpose, purpose)))
            .limit(1)

        const values = { modelRefId, optionsJson: JSON.stringify(options), updatedAt: new Date() }
        const [saved] = existing
            ? await db.update(aiBindings).set(values).where(eq(aiBindings.id, existing.id)).returning()
            : await db.insert(aiBindings).values({ userId: user.id, purpose, ...values }).returning()

        // 绑定向量模型时顺手探测维度：让用户立刻看到维度，并提前把该维度的向量索引建好。
        // 探测失败不影响绑定本身——真正 embed 时还会自愈一次。
        let model = row.model
        if (purpose === "EMBEDDING" && row.model.dimensions == null) {
            try {
                const dimensions = await probeEmbeddingDimensions(
                    buildRuntimeConfig(row.provider, row.credential),
                    row.model.modelId,
                )
                await persistDimensions(row.model.id, dimensions)
                model = { ...row.model, dimensions }
            } catch (error) {
                log.warn({
                    err: toLogError(error),
                    userId: user.id,
                    modelRefId: row.model.id,
                }, "绑定向量模型时探测维度失败，将在首次调用时重试")
            }
        }

        return ok(buildBindingResponse(saved, { model, provider: row.provider }))
    })
}

/** 解绑某个用途 */
export async function clearAiBinding(request: AppRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson<Record<string, unknown>>(request)
        const purpose = requirePurpose(raw.purpose)
        await getDb()
            .delete(aiBindings)
            .where(and(eq(aiBindings.userId, user.id), eq(aiBindings.purpose, purpose)))
        return new Response(null, { status: 200 })
    })
}
