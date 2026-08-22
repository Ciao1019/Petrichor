import { createRequire } from "node:module"
import { and, eq, inArray } from "drizzle-orm"
import { beforeAll, describe, expect, it, vi } from "vitest"

const runArticleKnowledgeBuildWorkflow = vi.hoisted(() => vi.fn())

vi.mock("./knowledge-build-workflow", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./knowledge-build-workflow")>()
    return {
        ...actual,
        runArticleKnowledgeBuildWorkflow,
    }
})

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("better-sqlite3")
        return true
    } catch {
        return false
    }
})()

describe.runIf(hasSqlite)("单篇文章知识重建", () => {
    let getDb: typeof import("@/server/db/client").getDb
    let schema: typeof import("@/server/db/schema")
    let buildArticleKnowledge: typeof import("./wiki-agent-logic").buildArticleKnowledge
    let userId = 0
    let knowledgeBaseId = 0
    let articleId = 0

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-article-knowledge-rebuild-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")
        ;({ buildArticleKnowledge } = await import("./wiki-agent-logic"))

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "article-knowledge-rebuild@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        userId = user.id

        const [knowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "文章知识重建测试库",
        }).returning({ id: schema.knowledgeBases.id })
        knowledgeBaseId = knowledgeBase.id

        const [node] = await db.insert(schema.knowledgeBaseNodes).values({
            userId,
            knowledgeBaseId,
            parentId: null,
            type: "ARTICLE",
            name: "重建测试文章",
            sortOrder: 1,
        }).returning({ id: schema.knowledgeBaseNodes.id })

        const [article] = await db.insert(schema.knowledgeBaseArticles).values({
            userId,
            knowledgeBaseId,
            nodeId: node.id,
            title: "重建测试文章",
            contentMd: "# 重建测试文章\n\n正文内容。",
        }).returning({ id: schema.knowledgeBaseArticles.id })
        articleId = article.id
    })

    it("相同内容再次构建时删除旧产物并创建新记录", async () => {
        runArticleKnowledgeBuildWorkflow
            .mockResolvedValueOnce(buildWorkflowResult("旧切片", "concept-old", "旧概念"))
            .mockResolvedValueOnce(buildWorkflowResult("新切片", "concept-new", "新概念"))

        const db = getDb()
        // better-sqlite3 的 transaction 回调必须同步；本用例只验证重建持久化语义，
        // 因此让回调直接使用同一个测试数据库执行。
        vi.spyOn(db, "transaction").mockImplementation(async (callback) => callback(db as never))

        const first = await buildArticleKnowledge({ userId, knowledgeBaseId, articleId })
        const [oldChunk] = await db
            .select({ id: schema.knowledgeBaseArticleChunks.id })
            .from(schema.knowledgeBaseArticleChunks)
            .where(eq(schema.knowledgeBaseArticleChunks.articleId, articleId))
        const oldSourcePageId = Number(first.sourcePage.id)
        const [oldConceptPage] = await db
            .select({ id: schema.knowledgeBaseWikiPages.id })
            .from(schema.knowledgeBaseWikiPages)
            .where(eq(schema.knowledgeBaseWikiPages.pageKey, "concept-old"))

        const second = await buildArticleKnowledge({ userId, knowledgeBaseId, articleId })

        expect(runArticleKnowledgeBuildWorkflow).toHaveBeenCalledTimes(2)
        expect(first.fromCache).toBe(false)
        expect(second.fromCache).toBe(false)
        expect(Number(second.sourcePage.id)).not.toBe(oldSourcePageId)

        const chunks = await db
            .select({ id: schema.knowledgeBaseArticleChunks.id, contentMd: schema.knowledgeBaseArticleChunks.contentMd })
            .from(schema.knowledgeBaseArticleChunks)
            .where(eq(schema.knowledgeBaseArticleChunks.articleId, articleId))
        expect(chunks).toHaveLength(1)
        expect(chunks[0]).toMatchObject({ contentMd: "新切片" })
        expect(chunks[0]?.id).not.toBe(oldChunk?.id)

        const retrievalIndexes = await db
            .select({
                chunkId: schema.knowledgeBaseArticleChunkIndexes.chunkId,
                sourceType: schema.knowledgeBaseArticleChunkIndexes.sourceType,
                content: schema.knowledgeBaseArticleChunkIndexes.content,
            })
            .from(schema.knowledgeBaseArticleChunkIndexes)
            .where(eq(schema.knowledgeBaseArticleChunkIndexes.articleId, articleId))
        expect(retrievalIndexes).toHaveLength(4)
        expect(retrievalIndexes.filter((item) => item.sourceType === "chunk")).toHaveLength(1)
        expect(retrievalIndexes.filter((item) => item.sourceType === "question")).toHaveLength(3)
        expect(retrievalIndexes.every((item) => item.chunkId === chunks[0]?.id)).toBe(true)
        expect(retrievalIndexes.map((item) => item.content)).toEqual(expect.arrayContaining([
            "新切片",
            "问题一",
            "问题二",
            "问题三",
        ]))

        const deletedPageIds = [oldSourcePageId, oldConceptPage?.id].filter((id): id is number => id != null)
        const deletedPages = await db
            .select({ id: schema.knowledgeBaseWikiPages.id })
            .from(schema.knowledgeBaseWikiPages)
            .where(inArray(schema.knowledgeBaseWikiPages.id, deletedPageIds))
        expect(deletedPages).toHaveLength(0)

        const currentConceptPages = await db
            .select({ pageKey: schema.knowledgeBaseWikiPages.pageKey })
            .from(schema.knowledgeBaseWikiPages)
            .where(and(
                eq(schema.knowledgeBaseWikiPages.userId, userId),
                eq(schema.knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
                eq(schema.knowledgeBaseWikiPages.kind, "concept"),
            ))
        expect(currentConceptPages.map((page) => page.pageKey)).toEqual(["concept-new"])

        const staleSourceRefs = await db
            .select({ pageId: schema.knowledgeBaseWikiSourceRefs.pageId })
            .from(schema.knowledgeBaseWikiSourceRefs)
            .where(inArray(schema.knowledgeBaseWikiSourceRefs.pageId, deletedPageIds))
        const staleLinks = await db
            .select({ fromPageId: schema.knowledgeBaseWikiLinks.fromPageId })
            .from(schema.knowledgeBaseWikiLinks)
            .where(inArray(schema.knowledgeBaseWikiLinks.fromPageId, deletedPageIds))
        expect(staleSourceRefs).toHaveLength(0)
        expect(staleLinks).toHaveLength(0)

        const buildEvents = await db
            .select({ pageId: schema.knowledgeBaseWikiEventLogs.pageId })
            .from(schema.knowledgeBaseWikiEventLogs)
            .where(eq(schema.knowledgeBaseWikiEventLogs.eventType, "ARTICLE_KNOWLEDGE_BUILD"))
        expect(buildEvents).toHaveLength(2)
        expect(buildEvents.filter((event) => event.pageId == null)).toHaveLength(1)
        expect(buildEvents.some((event) => event.pageId === Number(second.sourcePage.id))).toBe(true)
    })
})

function buildWorkflowResult(contentMd: string, pageKey: string, name: string) {
    return {
        chunks: [{
            chunkKey: "chunk-001",
            position: 0,
            heading: "重建测试文章",
            headingPath: ["重建测试文章"],
            contentMd,
            contentHash: `${contentMd}-hash`,
            recommendedQuestions: ["问题一", "问题二", "问题三"],
        }],
        documentSummary: `${name}摘要`,
        items: [{
            kind: "concept" as const,
            name,
            pageKey,
            aliases: [],
            summary: `${name}摘要`,
            categoryPath: ["测试"],
            contentMd: `# ${name}\n\n${name}正文。`,
            relatedPageKeys: [],
            relations: [],
        }],
        relations: [],
        warnings: [],
    }
}
