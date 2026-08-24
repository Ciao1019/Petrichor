import { and, asc, eq } from "drizzle-orm"
import { after, type NextRequest } from "next/server"
import { z } from "zod"
import { createLogger, toLogError } from "@/lib/logger"
import { requireCurrentUser } from "@/server/auth/current-user"
import { resolveModelContextWindow } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { aiBindings, aiModels, aiProviders } from "@/server/db/schema"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    applyWikiPatch,
    articleKnowledgeBuildInputSchema,
    articleKnowledgeChunkListInputSchema,
    ingestKnowledgeBaseWiki,
    listArticleKnowledgeChunks,
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
import { loadDocumentTreeOutline } from "@/server/kb/wiki-tree"
import { embedKnowledgeBaseArticleIndex } from "@/server/kb/article-knowledge-index"
import {
    enqueueArticleKnowledgeBuild,
    getArticleKnowledgeBuildJob,
    processArticleKnowledgeBuildJob,
} from "@/server/kb/article-knowledge-build-jobs"
import { idSchema } from "./wiki-agent-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>
const log = createLogger("wiki-agent-handler")
const articleKnowledgeBuildStatusInputSchema = z.object({ jobId: idSchema })

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
            fullRebuild: input.fullRebuild,
        }))
    })
}

export async function articleKnowledgeBuild(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = articleKnowledgeBuildInputSchema.parse(await readJson(request))
        const { job } = await enqueueArticleKnowledgeBuild({
            userId: user.id,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: input.articleId,
            forceRebuild: input.forceRebuild,
        })
        scheduleArticleKnowledgeBuild(job.id)
        return ok(job, { status: 202 })
    })
}

export async function articleKnowledgeBuildStatus(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = articleKnowledgeBuildStatusInputSchema.parse(await readJson(request))
        return ok(await getArticleKnowledgeBuildJob({ userId: user.id, jobId: input.jobId }))
    })
}

function scheduleArticleKnowledgeBuild(jobId: string) {
    const numericJobId = Number(jobId)
    const task = () => processArticleKnowledgeBuildJob(numericJobId)
    try {
        after(task)
    } catch (error) {
        // Vitest、脚本或非 Next 请求作用域没有 after 上下文时仍可执行。
        log.warn({ err: toLogError(error), jobId: numericJobId }, "Next after 不可用，降级到事件循环执行知识构建")
        setTimeout(() => {
            void task()
        }, 0)
    }
}

export async function articleKnowledgeChunkList(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = articleKnowledgeChunkListInputSchema.parse(await readJson(request))
        return ok(await listArticleKnowledgeChunks({
            userId: user.id,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: input.articleId,
        }))
    })
}

export async function wikiEmbeddingRun(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = wikiIngestInputSchema.pick({ knowledgeBaseId: true }).parse(await readJson(request))
        return ok(await embedKnowledgeBaseArticleIndex(user.id, input.knowledgeBaseId))
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
