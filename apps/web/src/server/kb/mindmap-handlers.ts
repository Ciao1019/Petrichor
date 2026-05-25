import { eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { knowledgeBaseArticles, knowledgeBases } from "@/server/db/schema"
import { callChatCompletion } from "@/server/ai/generation"
import { badRequest, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import { invalidatePublicArticleDetailCache, invalidatePublicArticleListCache } from "@/server/public-content-cache"
import {
    buildMindmapContentHash,
    buildMindmapSystemPrompt,
    buildMindmapUserMessage,
    extractJsonObjectText,
    isMindmapCacheHit,
    normalizeMindmapModelOutput,
    parseJsonOrNull,
    validateMindmapGenerateInput,
} from "./mindmap-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function generateArticleMindmap(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateMindmapGenerateInput(await readJson(request))
        const db = getDb()
        const [article] = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(eq(knowledgeBaseArticles.id, input.articleId))
            .limit(1)

        if (!article) {
            throw notFound("文章不存在")
        }

        requireWriteAccess(user.id, article.userId)
        const [kb] = await db
            .select()
            .from(knowledgeBases)
            .where(eq(knowledgeBases.id, article.knowledgeBaseId))
            .limit(1)
        if (!kb) {
            throw notFound("知识库不存在")
        }

        const currentHash = buildMindmapContentHash(article.title, article.contentMd)
        const storedHash = input.mode === "KNOWLEDGE_GRAPH" ? article.mindmapKgContentHash : article.mindmapContentHash
        const storedJson = input.mode === "KNOWLEDGE_GRAPH" ? article.mindmapKgJson : article.mindmapJson
        const storedGeneratedAt = input.mode === "KNOWLEDGE_GRAPH" ? article.mindmapKgGeneratedAt : article.mindmapGeneratedAt

        if (!input.forceRebuild && isMindmapCacheHit({ currentHash, storedHash, storedJson })) {
            const cached = parseJsonOrNull(storedJson)
            if (cached) {
                return ok({
                    articleId: String(article.id),
                    fromCache: true,
                    generatedAt: formatDate(storedGeneratedAt ?? article.updatedAt),
                    data: cached,
                })
            }
        }

        const generated = await generateByModel(user.id, kb.name, article.title, article.contentMd, input.mode)
        const generatedAt = new Date()
        if (input.mode === "KNOWLEDGE_GRAPH") {
            await db
                .update(knowledgeBaseArticles)
                .set({
                    mindmapKgJson: JSON.stringify(generated),
                    mindmapKgContentHash: currentHash,
                    mindmapKgGeneratedAt: generatedAt,
                    updatedAt: generatedAt,
                })
                .where(eq(knowledgeBaseArticles.id, article.id))
        } else {
            await db
                .update(knowledgeBaseArticles)
                .set({
                    mindmapJson: JSON.stringify(generated),
                    mindmapContentHash: currentHash,
                    mindmapGeneratedAt: generatedAt,
                    updatedAt: generatedAt,
                })
                .where(eq(knowledgeBaseArticles.id, article.id))
        }

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            fromCache: false,
            generatedAt: generatedAt.toISOString(),
            data: generated,
        })
    })
}

async function generateByModel(userId: number, knowledgeBaseName: string, title: string, contentMd: string, mode: "MINDMAP" | "KNOWLEDGE_GRAPH") {
    const result = await callChatCompletion({
        userId,
        systemPrompt: buildMindmapSystemPrompt(mode),
        message: buildMindmapUserMessage({ knowledgeBaseName, title, contentMd }),
    })
    try {
        const raw = JSON.parse(extractJsonObjectText(result.answer))
        return normalizeMindmapModelOutput(raw, title, mode)
    } catch (error) {
        if (error instanceof Error && error.message.includes("未找到可用的默认配置")) {
            throw error
        }
        throw badRequest(`生成${mode === "KNOWLEDGE_GRAPH" ? "知识图谱" : "思维导图"}失败，请稍后重试`)
    }
}

function requireWriteAccess(userId: number, ownerUserId: number) {
    if (ownerUserId === userId) {
        return
    }
    throw notFound("文章不存在")
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
