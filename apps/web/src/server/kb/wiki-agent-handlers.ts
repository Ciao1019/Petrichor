import { and, asc, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { resolveModelContextWindow } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { aiModelConfigs } from "@/server/db/schema"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    applyWikiPatch,
    ingestKnowledgeBaseWiki,
    listUserKnowledgeBases,
    listWikiPages,
    listWikiPatches,
    loadWikiDashboard,
    loadWikiPageDetail,
    rejectWikiPatch,
    runWikiLint,
    wikiIngestInputSchema,
    wikiPageDetailInputSchema,
    wikiPatchDecisionInputSchema,
    wikiTreeInputSchema,
} from "./wiki-agent-logic"
import { embedKnowledgeBaseTreeNodes, loadDocumentTreeOutline } from "@/server/kb/wiki-tree"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function wikiDashboard(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok(await loadWikiDashboard(user.id, input.knowledgeBaseId))
    })
}

export async function wikiPageList(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            pages: await listWikiPages(user.id, input.knowledgeBaseId),
        })
    })
}

export async function wikiPageDetail(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiPageDetailInputSchema.parse(await readJson(request))
        return ok(await loadWikiPageDetail(user.id, input.knowledgeBaseId, input.pageKey))
    })
}

export async function wikiTree(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiTreeInputSchema.parse(await readJson(request))
        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            articleId: input.articleId == null ? null : String(input.articleId),
            nodes: await loadDocumentTreeOutline(user.id, input.knowledgeBaseId, input.articleId),
        })
    })
}

export async function wikiIngest(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.parse(await readJson(request))
        return ok(await ingestKnowledgeBaseWiki({
            userId: user.id,
            knowledgeBaseId: input.knowledgeBaseId,
            articleIds: input.articleIds,
            forceRebuild: input.forceRebuild,
        }))
    })
}

export async function wikiEmbeddingRun(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok(await embedKnowledgeBaseTreeNodes(user.id, input.knowledgeBaseId))
    })
}

export async function wikiPatchList(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            patches: await listWikiPatches(user.id, input.knowledgeBaseId),
        })
    })
}

export async function wikiPatchApply(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiPatchDecisionInputSchema.parse(await readJson(request))
        return ok(await applyWikiPatch(user.id, input.knowledgeBaseId, input.patchId))
    })
}

export async function wikiPatchReject(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiPatchDecisionInputSchema.parse(await readJson(request))
        return ok(await rejectWikiPatch(user.id, input.knowledgeBaseId, input.patchId))
    })
}

export async function wikiLint(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok(await runWikiLint(user.id, input.knowledgeBaseId))
    })
}

export async function qaKnowledgeBaseList(request: NextRequest) {
    return withUser(request, async (user) => {
        return ok({ knowledgeBases: await listUserKnowledgeBases(user.id) })
    })
}

export async function qaModelInfo(request: NextRequest) {
    return withUser(request, async (user) => {
        const configs = await getDb()
            .select()
            .from(aiModelConfigs)
            .where(and(
                eq(aiModelConfigs.userId, user.id),
                eq(aiModelConfigs.configType, "CHAT"),
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
    })
}
