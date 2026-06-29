import { and, asc, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { aiModelConfigs } from "@/server/db/schema"
import { resolveModelContextWindow } from "@/server/ai/generation"
import { ok, toErrorResponse } from "@/server/http/response"

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const configs = await getDb()
            .select()
            .from(aiModelConfigs)
            .where(and(
                eq(aiModelConfigs.userId, user.id),
                eq(aiModelConfigs.configType, "DOC_QA"),
                eq(aiModelConfigs.enabled, true),
            ))
            .orderBy(asc(aiModelConfigs.id))

        const availableModels = configs.map((config) => ({
            configId: String(config.id),
            modelId: config.model,
            modelName: config.name,
            contextWindow: resolveModelContextWindow({ model: config.model, extraJson: config.extraJson }),
            isDefault: config.isDefault,
        }))

        const defaultConfig = configs.find((item) => item.isDefault) ?? configs[0] ?? null
        if (!defaultConfig) {
            return ok({ modelId: null, modelName: null, contextWindow: null, configId: null, availableModels })
        }
        return ok({
            configId: String(defaultConfig.id),
            modelId: defaultConfig.model,
            modelName: defaultConfig.name,
            contextWindow: resolveModelContextWindow({ model: defaultConfig.model, extraJson: defaultConfig.extraJson }),
            availableModels,
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
