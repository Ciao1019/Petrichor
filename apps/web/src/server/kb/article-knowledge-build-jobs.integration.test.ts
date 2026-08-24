import { createRequire } from "node:module"
import { beforeAll, describe, expect, it, vi } from "vitest"

const buildArticleKnowledge = vi.hoisted(() => vi.fn())

vi.mock("./wiki-agent-logic", () => ({ buildArticleKnowledge }))

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("better-sqlite3")
        return true
    } catch {
        return false
    }
})()

describe.runIf(hasSqlite)("文章知识异步构建任务", () => {
    let enqueue: typeof import("./article-knowledge-build-jobs").enqueueArticleKnowledgeBuild
    let getJob: typeof import("./article-knowledge-build-jobs").getArticleKnowledgeBuildJob
    let processJob: typeof import("./article-knowledge-build-jobs").processArticleKnowledgeBuildJob
    let userId = 0
    let knowledgeBaseId = 0
    let articleId = 0

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-article-build-job-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"
        process.env.LOG_LEVEL = "silent"

        const { getDb } = await import("@/server/db/client")
        const schema = await import("@/server/db/schema")
        ;({
            enqueueArticleKnowledgeBuild: enqueue,
            getArticleKnowledgeBuildJob: getJob,
            processArticleKnowledgeBuildJob: processJob,
        } = await import("./article-knowledge-build-jobs"))

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "article-build-job@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        userId = user.id

        const [knowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "异步知识构建测试库",
        }).returning({ id: schema.knowledgeBases.id })
        knowledgeBaseId = knowledgeBase.id

        const [node] = await db.insert(schema.knowledgeBaseNodes).values({
            userId,
            knowledgeBaseId,
            parentId: null,
            type: "ARTICLE",
            name: "异步构建测试文章",
            sortOrder: 1,
        }).returning({ id: schema.knowledgeBaseNodes.id })

        const [article] = await db.insert(schema.knowledgeBaseArticles).values({
            userId,
            knowledgeBaseId,
            nodeId: node.id,
            title: "异步构建测试文章",
            contentMd: "# 异步构建\n\n正文内容。",
        }).returning({ id: schema.knowledgeBaseArticles.id })
        articleId = article.id
    })

    it("同一文章复用活动任务，完成后持久化原构建结果", async () => {
        const result = {
            articleId: String(articleId),
            knowledgeBaseId: String(knowledgeBaseId),
            fromCache: false,
            chunkCount: 2,
            recommendedQuestionCount: 6,
            entityCount: 1,
            conceptCount: 1,
            sourcePage: { id: "99" },
            warnings: [],
        }
        buildArticleKnowledge.mockResolvedValueOnce(result)

        const first = await enqueue({ userId, knowledgeBaseId, articleId })
        const duplicate = await enqueue({ userId, knowledgeBaseId, articleId })
        expect(first.created).toBe(true)
        expect(duplicate.created).toBe(false)
        expect(duplicate.job.id).toBe(first.job.id)
        expect(first.job.status).toBe("pending")

        await Promise.all([
            processJob(Number(first.job.id)),
            processJob(Number(first.job.id)),
        ])

        const completed = await getJob({ userId, jobId: Number(first.job.id) })
        expect(buildArticleKnowledge).toHaveBeenCalledTimes(1)
        expect(completed.status).toBe("completed")
        expect(completed.result).toEqual(result)
        expect(completed.error).toBeNull()
        expect(completed.startedAt).not.toBeNull()
        expect(completed.completedAt).not.toBeNull()
    })

    it("失败时释放文章活动键，允许重新入队", async () => {
        buildArticleKnowledge.mockRejectedValueOnce(new Error("provider secret detail"))
        const failedRun = await enqueue({ userId, knowledgeBaseId, articleId, forceRebuild: true })
        await processJob(Number(failedRun.job.id))

        const failed = await getJob({ userId, jobId: Number(failedRun.job.id) })
        expect(failed.status).toBe("failed")
        expect(failed.error).toBe("知识构建失败，请稍后重试")
        expect(failed.error).not.toContain("secret")

        const retry = await enqueue({ userId, knowledgeBaseId, articleId })
        expect(retry.created).toBe(true)
        expect(retry.job.id).not.toBe(failedRun.job.id)
    })
})
