import { and, eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { callChatCompletion } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { knowledgeBaseArticles } from "@/server/db/schema"
import { invalidatePublicArticleDetailCache, invalidatePublicArticleListCache } from "@/server/public-content-cache"
import { notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import {
    buildArticleAiSummaryContentHash,
    buildArticleSummarySystemPrompt,
    buildArticleSummaryUserMessage,
    isArticleAiSummaryCacheHit,
    normalizeArticleSummaryModelOutput,
    validateArticleSummaryGenerateInput,
} from "./article-summary-logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: NextRequest, handler: (user: User) => Promise<Response>) {
    try {
        const user = await requireCurrentUser(request)
        return await handler(user)
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function generateArticleSummary(request: NextRequest) {
    return withUser(request, async (user) => {
        const input = validateArticleSummaryGenerateInput(await readJson(request))
        const db = getDb()
        const [article] = await db
            .select()
            .from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.id, input.articleId), eq(knowledgeBaseArticles.userId, user.id)))
            .limit(1)

        if (!article) {
            throw notFound("文章不存在")
        }

        const currentHash = buildArticleAiSummaryContentHash(article.contentMd)
        if (!input.forceRebuild && isArticleAiSummaryCacheHit({
            currentHash,
            storedHash: article.aiSummaryContentHash,
            summary: article.aiSummary,
        })) {
            return ok({
                articleId: String(article.id),
                fromCache: true,
                summary: article.aiSummary?.trim() ?? "",
                generatedAt: formatDateOrNull(article.aiSummaryGeneratedAt ?? article.updatedAt),
            })
        }

        const result = await callChatCompletion({
            userId: user.id,
            systemPrompt: buildArticleSummarySystemPrompt(),
            message: buildArticleSummaryUserMessage({
                title: article.title,
                contentMd: article.contentMd,
            }),
        })
        const summary = normalizeArticleSummaryModelOutput(result.answer)
        const generatedAt = new Date()

        await db
            .update(knowledgeBaseArticles)
            .set({
                aiSummary: summary,
                aiSummaryContentHash: currentHash,
                aiSummaryGeneratedAt: generatedAt,
                updatedAt: generatedAt,
            })
            .where(and(eq(knowledgeBaseArticles.id, article.id), eq(knowledgeBaseArticles.userId, user.id)))

        invalidatePublicArticleListCache()
        invalidatePublicArticleDetailCache()
        return ok({
            articleId: String(article.id),
            fromCache: false,
            summary,
            generatedAt: generatedAt.toISOString(),
        })
    })
}

function formatDateOrNull(value: Date | string | null | undefined) {
    if (!value) {
        return null
    }
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
