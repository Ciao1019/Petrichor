import { and, eq, inArray, lt } from "drizzle-orm"

import { createLogger, toLogError } from "@/lib/logger"
import { getDb } from "@/server/db/client"
import {
    knowledgeBaseArticleBuildJobs,
    knowledgeBaseArticles,
    type KnowledgeBaseArticleBuildJobRecord,
} from "@/server/db/schema"
import { badRequest, conflict, HttpError, notFound } from "@/server/http/response"
import { buildArticleKnowledge } from "@/server/kb/wiki-agent-logic"

const log = createLogger("article-knowledge-build-job")
const ACTIVE_JOB_STATUSES = ["pending", "processing"]
const BUILD_JOB_STALE_MS = 10 * 60 * 1_000

export type ArticleKnowledgeBuildJobStatus = "pending" | "processing" | "completed" | "failed"
export type ArticleKnowledgeBuildResult = Awaited<ReturnType<typeof buildArticleKnowledge>>

export interface ArticleKnowledgeBuildJobResponse {
    id: string
    userId: string
    knowledgeBaseId: string
    articleId: string
    status: ArticleKnowledgeBuildJobStatus
    result: ArticleKnowledgeBuildResult | null
    error: string | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string | null
    updatedAt: string | null
}

function formatDate(value: Date | null | undefined) {
    return value?.toISOString() ?? null
}

function activeKey(userId: number, articleId: number) {
    return `${userId}:${articleId}`
}

function parseResult(raw: string | null): ArticleKnowledgeBuildResult | null {
    if (!raw) return null
    try {
        return JSON.parse(raw) as ArticleKnowledgeBuildResult
    } catch (error) {
        log.error({ err: toLogError(error) }, "异步知识构建结果 JSON 损坏")
        return null
    }
}

function toJobResponse(job: KnowledgeBaseArticleBuildJobRecord): ArticleKnowledgeBuildJobResponse {
    return {
        id: String(job.id),
        userId: String(job.userId),
        knowledgeBaseId: String(job.knowledgeBaseId),
        articleId: String(job.articleId),
        status: job.status as ArticleKnowledgeBuildJobStatus,
        result: parseResult(job.resultJson),
        error: job.error,
        startedAt: formatDate(job.startedAt),
        completedAt: formatDate(job.completedAt),
        createdAt: formatDate(job.createdAt),
        updatedAt: formatDate(job.updatedAt),
    }
}

async function expireStaleActiveJob(userId: number, articleId: number) {
    const db = getDb()
    const staleBefore = new Date(Date.now() - BUILD_JOB_STALE_MS)
    const expired = await db
        .update(knowledgeBaseArticleBuildJobs)
        .set({
            activeKey: null,
            status: "failed",
            error: "知识构建任务执行超时，请重新构建",
            completedAt: new Date(),
            updatedAt: new Date(),
        })
        .where(and(
            eq(knowledgeBaseArticleBuildJobs.userId, userId),
            eq(knowledgeBaseArticleBuildJobs.articleId, articleId),
            inArray(knowledgeBaseArticleBuildJobs.status, ACTIVE_JOB_STATUSES),
            lt(knowledgeBaseArticleBuildJobs.updatedAt, staleBefore),
        ))
        .returning({ id: knowledgeBaseArticleBuildJobs.id })

    if (expired.length > 0) {
        log.warn({ userId, articleId, jobIds: expired.map((job) => job.id) }, "已回收超时的知识构建任务")
    }
}

export async function enqueueArticleKnowledgeBuild(input: {
    userId: number
    knowledgeBaseId: number
    articleId: number
    forceRebuild?: boolean
}): Promise<{ job: ArticleKnowledgeBuildJobResponse; created: boolean }> {
    const db = getDb()
    const [article] = await db
        .select({ id: knowledgeBaseArticles.id, contentMd: knowledgeBaseArticles.contentMd })
        .from(knowledgeBaseArticles)
        .where(and(
            eq(knowledgeBaseArticles.id, input.articleId),
            eq(knowledgeBaseArticles.userId, input.userId),
            eq(knowledgeBaseArticles.knowledgeBaseId, input.knowledgeBaseId),
        ))
        .limit(1)
    if (!article) throw notFound("文章不存在")
    if (!article.contentMd.trim()) throw badRequest("文章没有可构建的 Markdown 内容")

    await expireStaleActiveJob(input.userId, input.articleId)

    const key = activeKey(input.userId, input.articleId)
    const [inserted] = await db
        .insert(knowledgeBaseArticleBuildJobs)
        .values({
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: input.articleId,
            activeKey: key,
            status: "pending",
            forceRebuild: Boolean(input.forceRebuild),
        })
        .onConflictDoNothing({ target: knowledgeBaseArticleBuildJobs.activeKey })
        .returning()

    if (inserted) {
        log.info({
            jobId: inserted.id,
            userId: input.userId,
            knowledgeBaseId: input.knowledgeBaseId,
            articleId: input.articleId,
        }, "知识构建任务已入队")
        return { job: toJobResponse(inserted), created: true }
    }

    const [active] = await db
        .select()
        .from(knowledgeBaseArticleBuildJobs)
        .where(eq(knowledgeBaseArticleBuildJobs.activeKey, key))
        .limit(1)
    if (!active) throw conflict("知识构建任务正在创建，请稍后重试")

    log.info({
        jobId: active.id,
        userId: input.userId,
        knowledgeBaseId: input.knowledgeBaseId,
        articleId: input.articleId,
    }, "复用文章已有的知识构建任务")
    return { job: toJobResponse(active), created: false }
}

export async function getArticleKnowledgeBuildJob(input: {
    userId: number
    jobId: number
}): Promise<ArticleKnowledgeBuildJobResponse> {
    const db = getDb()
    let [job] = await db
        .select()
        .from(knowledgeBaseArticleBuildJobs)
        .where(and(
            eq(knowledgeBaseArticleBuildJobs.id, input.jobId),
            eq(knowledgeBaseArticleBuildJobs.userId, input.userId),
        ))
        .limit(1)
    if (!job) throw notFound("知识构建任务不存在")

    if (ACTIVE_JOB_STATUSES.includes(job.status)) {
        await expireStaleActiveJob(job.userId, job.articleId)
        ;[job] = await db
            .select()
            .from(knowledgeBaseArticleBuildJobs)
            .where(and(
                eq(knowledgeBaseArticleBuildJobs.id, input.jobId),
                eq(knowledgeBaseArticleBuildJobs.userId, input.userId),
            ))
            .limit(1)
    }
    if (!job) throw notFound("知识构建任务不存在")
    return toJobResponse(job)
}

function publicErrorMessage(error: unknown) {
    return error instanceof HttpError ? error.message : "知识构建失败，请稍后重试"
}

/**
 * 真正执行构建的后台入口。pending -> processing 的条件更新就是任务 claim，
 * 即使 after 回调被重复调度，也只有一个执行者会进入原有构建逻辑。
 */
export async function processArticleKnowledgeBuildJob(jobId: number): Promise<void> {
    const db = getDb()
    const startedAt = new Date()
    const [job] = await db
        .update(knowledgeBaseArticleBuildJobs)
        .set({ status: "processing", startedAt, updatedAt: startedAt })
        .where(and(
            eq(knowledgeBaseArticleBuildJobs.id, jobId),
            eq(knowledgeBaseArticleBuildJobs.status, "pending"),
        ))
        .returning()
    if (!job) {
        log.debug({ jobId }, "知识构建任务已被其他执行者领取或已经结束")
        return
    }

    const jobLog = log.child({
        jobId: job.id,
        userId: job.userId,
        knowledgeBaseId: job.knowledgeBaseId,
        articleId: job.articleId,
    })
    jobLog.info("开始执行知识构建任务")

    try {
        const result = await buildArticleKnowledge({
            userId: job.userId,
            knowledgeBaseId: job.knowledgeBaseId,
            articleId: job.articleId,
            forceRebuild: job.forceRebuild,
        })
        const completedAt = new Date()
        const updated = await db
            .update(knowledgeBaseArticleBuildJobs)
            .set({
                activeKey: null,
                status: "completed",
                resultJson: JSON.stringify(result),
                error: null,
                completedAt,
                updatedAt: completedAt,
            })
            .where(and(
                eq(knowledgeBaseArticleBuildJobs.id, job.id),
                eq(knowledgeBaseArticleBuildJobs.status, "processing"),
            ))
            .returning({ id: knowledgeBaseArticleBuildJobs.id })

        if (updated.length === 0) {
            jobLog.warn("知识构建已完成，但任务状态已被超时回收")
            return
        }
        jobLog.info({
            durationMs: completedAt.getTime() - startedAt.getTime(),
            chunkCount: result.chunkCount,
            entityCount: result.entityCount,
            conceptCount: result.conceptCount,
            warningCount: result.warnings.length,
        }, "知识构建任务完成")
    } catch (error) {
        const completedAt = new Date()
        jobLog.error({
            err: toLogError(error),
            durationMs: completedAt.getTime() - startedAt.getTime(),
        }, "知识构建任务失败")
        await db
            .update(knowledgeBaseArticleBuildJobs)
            .set({
                activeKey: null,
                status: "failed",
                resultJson: null,
                error: publicErrorMessage(error),
                completedAt,
                updatedAt: completedAt,
            })
            .where(and(
                eq(knowledgeBaseArticleBuildJobs.id, job.id),
                eq(knowledgeBaseArticleBuildJobs.status, "processing"),
            ))
    }
}
