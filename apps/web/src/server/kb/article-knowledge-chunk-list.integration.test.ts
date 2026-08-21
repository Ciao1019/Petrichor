import { createRequire } from "node:module"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("better-sqlite3")
        return true
    } catch {
        return false
    }
})()

describe.runIf(hasSqlite)("文章分片查询", () => {
    let getDb: typeof import("@/server/db/client").getDb
    let schema: typeof import("@/server/db/schema")
    let listArticleKnowledgeChunks: typeof import("./wiki-agent-logic").listArticleKnowledgeChunks
    let stableHash: typeof import("./wiki-agent-logic").stableHash
    let CHUNK_ALGORITHM_VERSION: number
    let userId = 0
    let knowledgeBaseId = 0
    let articleId = 0

    const articleTitle = "分片查询测试文章"
    const contentMd = "# 分片查询测试文章\n\n正文内容。"

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-article-chunk-list-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")
        ;({ listArticleKnowledgeChunks, stableHash } = await import("./wiki-agent-logic"))
        ;({ CHUNK_ALGORITHM_VERSION } = await import("./knowledge-build-workflow"))

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "article-chunk-list@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        userId = user.id

        const [knowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "分片查询测试库",
        }).returning({ id: schema.knowledgeBases.id })
        knowledgeBaseId = knowledgeBase.id

        const [node] = await db.insert(schema.knowledgeBaseNodes).values({
            userId,
            knowledgeBaseId,
            parentId: null,
            type: "ARTICLE",
            name: articleTitle,
            sortOrder: 1,
        }).returning({ id: schema.knowledgeBaseNodes.id })

        const [article] = await db.insert(schema.knowledgeBaseArticles).values({
            userId,
            knowledgeBaseId,
            nodeId: node.id,
            title: articleTitle,
            contentMd,
        }).returning({ id: schema.knowledgeBaseArticles.id })
        articleId = article.id
    })

    it("未构建时返回空列表", async () => {
        const result = await listArticleKnowledgeChunks({ userId, knowledgeBaseId, articleId })
        expect(result).toMatchObject({ built: false, stale: false, chunkCount: 0, questionCount: 0 })
        expect(result.chunks).toEqual([])
    })

    it("按 position 返回分片与推荐问题，正文改动后标记为过期", async () => {
        const db = getDb()
        await db.insert(schema.knowledgeBaseArticleChunks).values([
            {
                userId,
                knowledgeBaseId,
                articleId,
                chunkKey: "chunk-002",
                position: 1,
                heading: "第二段",
                contentMd: "第二段正文",
                contentHash: "hash-2",
                recommendedQuestionsJson: JSON.stringify(["问题三"]),
            },
            {
                userId,
                knowledgeBaseId,
                articleId,
                chunkKey: "chunk-001",
                position: 0,
                heading: "第一段",
                contentMd: "第一段正文",
                contentHash: "hash-1",
                headingPathJson: JSON.stringify(["第一段"]),
                // 空白项应被丢弃，避免 UI 渲染空问题
                recommendedQuestionsJson: JSON.stringify(["问题一", "  ", "问题二"]),
            },
        ])
        await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId,
            pageKey: `source-${articleId}`,
            title: articleTitle,
            kind: "source",
            contentMd: "源页面",
            contentHash: "source-hash",
            frontmatterJson: JSON.stringify({
                sourceHash: stableHash(`${articleTitle}\n${contentMd}`),
                chunkAlgorithmVersion: CHUNK_ALGORITHM_VERSION,
            }),
        })

        const fresh = await listArticleKnowledgeChunks({ userId, knowledgeBaseId, articleId })
        expect(fresh).toMatchObject({ built: true, stale: false, chunkCount: 2, questionCount: 3 })
        expect(fresh.chunks.map((chunk) => chunk.chunkKey)).toEqual(["chunk-001", "chunk-002"])
        expect(fresh.chunks[0]).toMatchObject({
            heading: "第一段",
            charCount: "第一段正文".length,
            recommendedQuestions: ["问题一", "问题二"],
        })

        await db
            .update(schema.knowledgeBaseArticles)
            .set({ contentMd: `${contentMd}\n\n新增一段。` })
            .where(eq(schema.knowledgeBaseArticles.id, articleId))

        const stale = await listArticleKnowledgeChunks({ userId, knowledgeBaseId, articleId })
        expect(stale).toMatchObject({ built: true, stale: true, chunkCount: 2 })
    })

    it("旧版切分算法产出的分片即使正文未变也标记为过期", async () => {
        const db = getDb()
        // 存量数据没有 chunkAlgorithmVersion 字段，应按 0 处理
        await db
            .update(schema.knowledgeBaseWikiPages)
            .set({ frontmatterJson: JSON.stringify({ sourceHash: stableHash(`${articleTitle}\n${contentMd}`) }) })
            .where(eq(schema.knowledgeBaseWikiPages.pageKey, `source-${articleId}`))
        await db
            .update(schema.knowledgeBaseArticles)
            .set({ contentMd })
            .where(eq(schema.knowledgeBaseArticles.id, articleId))

        const result = await listArticleKnowledgeChunks({ userId, knowledgeBaseId, articleId })
        expect(result).toMatchObject({ built: true, stale: true, chunkAlgorithmVersion: 0 })
        expect(result.currentChunkAlgorithmVersion).toBe(CHUNK_ALGORITHM_VERSION)
    })

    it("其他用户不能读取该知识库的分片", async () => {
        await expect(
            listArticleKnowledgeChunks({ userId: userId + 999, knowledgeBaseId, articleId }),
        ).rejects.toThrow()
    })
})
