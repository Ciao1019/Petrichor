import { and, asc, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { resolveModelContextWindow } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { aiBindings, aiModels, aiProviders } from "@/server/db/schema"
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
        // 可选模型 = 所有已启用的语言模型（跨供应商），当前项 = CHAT 用途的绑定
        const rows = await getDb()
            .select({ model: aiModels, provider: aiProviders })
            .from(aiModels)
            .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
            .where(and(
                eq(aiModels.userId, user.id),
                eq(aiModels.kind, "LANGUAGE"),
                eq(aiModels.enabled, true),
                eq(aiProviders.enabled, true),
            ))
            .orderBy(asc(aiProviders.name), asc(aiModels.modelId))

        const availableModels = rows.map((row) => ({
            configId: String(row.model.id),
            modelId: row.model.modelId,
            modelName: row.model.displayName ?? `${row.provider.name} · ${row.model.modelId}`,
            contextWindow: resolveModelContextWindow({
                model: row.model.modelId,
                contextWindow: row.model.contextWindow,
            }),
            isDefault: false,
        }))

        const [binding] = await getDb()
            .select()
            .from(aiBindings)
            .where(and(eq(aiBindings.userId, user.id), eq(aiBindings.purpose, "CHAT")))
            .limit(1)

        const current = binding
            ? availableModels.find((item) => item.configId === String(binding.modelRefId)) ?? null
            : null
        const fallback = current ?? availableModels[0] ?? null

        if (!fallback) {
            return ok({ modelId: null, modelName: null, contextWindow: null, configId: null, availableModels })
        }

        return ok({
            configId: fallback.configId,
            modelId: fallback.modelId,
            modelName: fallback.modelName,
            contextWindow: fallback.contextWindow,
            availableModels: availableModels.map((item) => ({
                ...item,
                isDefault: item.configId === fallback.configId,
            })),
        })
    })
}
