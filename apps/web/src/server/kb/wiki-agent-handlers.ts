import { and, asc, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { resolveChatConfig, resolveModelContextWindow } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { aiModelConfigs } from "@/server/db/schema"
import { badRequest, ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    agentArtifactCreateInputSchema,
    agentThreadCreateInputSchema,
    agentThreadInputSchema,
    applyWikiPatch,
    createAgentArtifact,
    createAgentThread,
    deleteAgentThread,
    deleteAgentThreads,
    ingestKnowledgeBaseWiki,
    listAgentArtifacts,
    listAgentThreads,
    listAllAgentThreads,
    listUserKnowledgeBases,
    listWikiPages,
    listWikiPatches,
    loadAgentThreadDetail,
    loadWikiDashboard,
    loadWikiPageDetail,
    parseAgentThreadScope,
    qaThreadCreateInputSchema,
    qaThreadDeleteInputSchema,
    qaThreadDeleteManyInputSchema,
    qaThreadDetailInputSchema,
    qaThreadListInputSchema,
    rejectWikiPatch,
    runWikiLint,
    wikiIngestInputSchema,
    wikiPageDetailInputSchema,
    wikiPatchDecisionInputSchema,
} from "./wiki-agent-logic"

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

export async function agentThreadList(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            threads: await listAgentThreads(user.id, input.knowledgeBaseId),
        })
    })
}

export async function agentThreadCreate(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentThreadCreateInputSchema.parse(await readJson(request))
        const thread = await createAgentThread({
            userId: user.id,
            knowledgeBaseId: input.knowledgeBaseId,
            title: input.title,
        })
        return ok({
            id: String(thread.id),
            knowledgeBaseId: thread.knowledgeBaseId == null ? null : String(thread.knowledgeBaseId),
            title: thread.title,
            status: thread.status,
        })
    })
}

export async function agentThreadDetail(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentThreadInputSchema.required({ threadId: true }).parse(await readJson(request))
        return ok(await loadAgentThreadDetail(user.id, input.threadId, input.knowledgeBaseId))
    })
}

export async function agentArtifactList(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentThreadInputSchema.parse(await readJson(request))
        return ok({
            knowledgeBaseId: String(input.knowledgeBaseId),
            artifacts: await listAgentArtifacts(user.id, input.knowledgeBaseId, input.threadId),
        })
    })
}

export async function agentArtifactCreate(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = agentArtifactCreateInputSchema.parse(await readJson(request))
        return ok(await createAgentArtifact({
            userId: user.id,
            knowledgeBaseId: input.knowledgeBaseId,
            threadId: input.threadId,
            runId: input.runId ?? null,
            artifactType: input.artifactType,
            title: input.title,
            contentMd: input.contentMd,
            payload: input.payload,
        }))
    })
}

export async function qaThreadList(request: NextRequest) {
    return withUser(request, async (user) => {
        const raw = await readJson(request)
        const input = qaThreadListInputSchema.parse(raw ?? {})
        const scope = parseAgentThreadScope(input.scope)
        if (scope === null) throw badRequest("无效的 scope 参数")
        const result = await listAllAgentThreads(user.id, {
            cursor: input.cursor,
            limit: input.limit,
            query: input.q,
            scope,
        })
        return ok(result)
    })
}

export async function qaThreadDetail(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = qaThreadDetailInputSchema.parse(await readJson(request))
        return ok(await loadAgentThreadDetail(user.id, input.threadId))
    })
}

export async function qaThreadCreate(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = qaThreadCreateInputSchema.parse(await readJson(request))
        const thread = await createAgentThread({
            userId: user.id,
            knowledgeBaseId: input.knowledgeBaseId ?? null,
            title: input.title,
        })
        return ok({
            id: String(thread.id),
            knowledgeBaseId: thread.knowledgeBaseId == null ? null : String(thread.knowledgeBaseId),
            title: thread.title,
            status: thread.status,
        })
    })
}

export async function qaThreadDelete(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = qaThreadDeleteInputSchema.parse(await readJson(request))
        return ok(await deleteAgentThread(user.id, input.threadId))
    })
}

export async function qaThreadDeleteMany(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = qaThreadDeleteManyInputSchema.parse(await readJson(request))
        return ok(await deleteAgentThreads(user.id, input.threadIds))
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
