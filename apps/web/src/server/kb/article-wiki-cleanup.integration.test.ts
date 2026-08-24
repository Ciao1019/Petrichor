import { createRequire } from "node:module"
import { eq } from "drizzle-orm"
import type { NextRequest } from "next/server"
import { beforeAll, describe, expect, it, vi } from "vitest"

const authMocks = vi.hoisted(() => ({
    requireCurrentUser: vi.fn(),
}))

vi.mock("@/server/auth/current-user", () => authMocks)
vi.mock("@/server/public-content-cache", () => ({
    invalidatePublicArticleDetailCache: vi.fn(),
    invalidatePublicArticleListCache: vi.fn(),
}))

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("bun:sqlite")
        return true
    } catch {
        return false
    }
})()

describe.runIf(hasSqlite)("article Wiki cleanup integration", () => {
    let getDb: typeof import("@/server/db/client").getDb
    let schema: typeof import("@/server/db/schema")
    let deleteArticle: typeof import("./handlers").deleteArticle
    let ingestKnowledgeBaseWiki: typeof import("./wiki-agent-logic").ingestKnowledgeBaseWiki
    let userId = 0
    let knowledgeBaseId = 0
    let orphanKnowledgeBaseId = 0
    let deletedArticleId = 0
    let keptArticleId = 0
    let deletedNodeId = 0
    let deletedPageId = 0
    let eventLogId = 0
    let patchId = 0

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-article-wiki-cleanup-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")
        ;({ deleteArticle } = await import("./handlers"))
        ;({ ingestKnowledgeBaseWiki } = await import("./wiki-agent-logic"))

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "article-wiki-cleanup@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        userId = user.id
        authMocks.requireCurrentUser.mockResolvedValue({ id: userId })

        const [knowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "Wiki 清理测试库",
        }).returning({ id: schema.knowledgeBases.id })
        knowledgeBaseId = knowledgeBase.id

        const [deletedNode, keptNode] = await db.insert(schema.knowledgeBaseNodes).values([
            {
                userId,
                knowledgeBaseId,
                parentId: null,
                type: "ARTICLE",
                name: "待删除文章",
                sortOrder: 1,
            },
            {
                userId,
                knowledgeBaseId,
                parentId: null,
                type: "ARTICLE",
                name: "保留文章",
                sortOrder: 2,
            },
        ]).returning({ id: schema.knowledgeBaseNodes.id })
        deletedNodeId = deletedNode.id

        const [deletedArticle, keptArticle] = await db.insert(schema.knowledgeBaseArticles).values([
            {
                userId,
                knowledgeBaseId,
                nodeId: deletedNode.id,
                title: "待删除文章",
                contentMd: "# 待删除内容",
            },
            {
                userId,
                knowledgeBaseId,
                nodeId: keptNode.id,
                title: "保留文章",
                contentMd: "# 保留内容",
            },
        ]).returning({ id: schema.knowledgeBaseArticles.id })
        deletedArticleId = deletedArticle.id
        keptArticleId = keptArticle.id

        const [indexPage, deletedPage] = await db.insert(schema.knowledgeBaseWikiPages).values([
            {
                userId,
                knowledgeBaseId,
                pageKey: "index",
                title: "Wiki 清理测试库 Wiki 索引",
                kind: "index",
                contentMd: `[[source-${deletedArticleId}]]\n[[source-${keptArticleId}]]`,
                contentHash: "old-index-hash",
            },
            {
                userId,
                knowledgeBaseId,
                pageKey: `source-${deletedArticleId}`,
                title: "待删除文章",
                kind: "source",
                contentMd: "# 待删除内容",
                contentHash: "deleted-source-hash",
            },
            {
                userId,
                knowledgeBaseId,
                pageKey: `source-${keptArticleId}`,
                title: "保留文章",
                kind: "source",
                contentMd: "# 保留内容",
                contentHash: "kept-source-hash",
            },
        ]).returning({ id: schema.knowledgeBaseWikiPages.id })
        deletedPageId = deletedPage.id

        await db.insert(schema.knowledgeBaseWikiSourceRefs).values({
            pageId: deletedPage.id,
            articleId: deletedArticleId,
            note: "源文档",
        })
        await db.insert(schema.knowledgeBaseWikiTreeNodes).values({
            userId,
            knowledgeBaseId,
            pageId: deletedPage.id,
            articleId: deletedArticleId,
            nodeKey: `article-${deletedArticleId}:root`,
            depth: 0,
            position: 0,
            title: "待删除文章",
            contentMd: "# 待删除内容",
            contentHash: "deleted-tree-hash",
        })
        await db.insert(schema.knowledgeBaseWikiLinks).values([
            {
                userId,
                knowledgeBaseId,
                fromPageId: indexPage.id,
                toPageKey: `source-${deletedArticleId}`,
                linkType: "index",
            },
            {
                userId,
                knowledgeBaseId,
                fromPageId: deletedPage.id,
                toPageKey: `source-${keptArticleId}`,
                linkType: "related",
            },
        ])
        const [eventLog] = await db.insert(schema.knowledgeBaseWikiEventLogs).values({
            userId,
            knowledgeBaseId,
            eventType: "INGEST",
            pageId: deletedPage.id,
        }).returning({ id: schema.knowledgeBaseWikiEventLogs.id })
        eventLogId = eventLog.id
        const [patch] = await db.insert(schema.knowledgeBaseWikiPatches).values({
            userId,
            knowledgeBaseId,
            pageKey: `source-${deletedArticleId}`,
            title: "待删除文章",
            operation: "UPDATE",
            status: "PENDING",
            proposedContentMd: "# 修改后的内容",
            diffText: "测试补丁",
        }).returning({ id: schema.knowledgeBaseWikiPatches.id })
        patchId = patch.id

        const [orphanKnowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "历史孤儿页测试库",
        }).returning({ id: schema.knowledgeBases.id })
        orphanKnowledgeBaseId = orphanKnowledgeBase.id
        await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId: orphanKnowledgeBaseId,
            pageKey: "source-999999",
            title: "文章早已删除",
            kind: "source",
            contentMd: "# 历史残留内容",
            contentHash: "orphan-source-hash",
        })
    })

    it("删除文章时同步删除 Wiki 页面并刷新索引", async () => {
        const request = {
            json: async () => ({ articleId: String(deletedArticleId) }),
            nextUrl: { pathname: "/api/kb/article/delete" },
        } as unknown as NextRequest

        const response = await deleteArticle(request)
        await expect(response.json()).resolves.toMatchObject({
            articleId: String(deletedArticleId),
            nodeId: String(deletedNodeId),
        })

        const db = getDb()
        const deletedArticles = await db
            .select({ id: schema.knowledgeBaseArticles.id })
            .from(schema.knowledgeBaseArticles)
            .where(eq(schema.knowledgeBaseArticles.id, deletedArticleId))
        const deletedNodes = await db
            .select({ id: schema.knowledgeBaseNodes.id })
            .from(schema.knowledgeBaseNodes)
            .where(eq(schema.knowledgeBaseNodes.id, deletedNodeId))
        const deletedPages = await db
            .select({ id: schema.knowledgeBaseWikiPages.id })
            .from(schema.knowledgeBaseWikiPages)
            .where(eq(schema.knowledgeBaseWikiPages.id, deletedPageId))
        const sourceRefs = await db
            .select({ id: schema.knowledgeBaseWikiSourceRefs.id })
            .from(schema.knowledgeBaseWikiSourceRefs)
            .where(eq(schema.knowledgeBaseWikiSourceRefs.pageId, deletedPageId))
        const treeNodes = await db
            .select({ id: schema.knowledgeBaseWikiTreeNodes.id })
            .from(schema.knowledgeBaseWikiTreeNodes)
            .where(eq(schema.knowledgeBaseWikiTreeNodes.pageId, deletedPageId))
        const staleLinks = await db
            .select({ id: schema.knowledgeBaseWikiLinks.id })
            .from(schema.knowledgeBaseWikiLinks)
            .where(eq(schema.knowledgeBaseWikiLinks.toPageKey, `source-${deletedArticleId}`))
        const [eventLog] = await db
            .select({ pageId: schema.knowledgeBaseWikiEventLogs.pageId })
            .from(schema.knowledgeBaseWikiEventLogs)
            .where(eq(schema.knowledgeBaseWikiEventLogs.id, eventLogId))
        const [patch] = await db
            .select({ status: schema.knowledgeBaseWikiPatches.status })
            .from(schema.knowledgeBaseWikiPatches)
            .where(eq(schema.knowledgeBaseWikiPatches.id, patchId))
        const [indexPage] = await db
            .select({ contentMd: schema.knowledgeBaseWikiPages.contentMd })
            .from(schema.knowledgeBaseWikiPages)
            .where(eq(schema.knowledgeBaseWikiPages.pageKey, "index"))
        const keptPages = await db
            .select({ id: schema.knowledgeBaseWikiPages.id })
            .from(schema.knowledgeBaseWikiPages)
            .where(eq(schema.knowledgeBaseWikiPages.pageKey, `source-${keptArticleId}`))

        expect(deletedArticles).toHaveLength(0)
        expect(deletedNodes).toHaveLength(0)
        expect(deletedPages).toHaveLength(0)
        expect(sourceRefs).toHaveLength(0)
        expect(treeNodes).toHaveLength(0)
        expect(staleLinks).toHaveLength(0)
        expect(eventLog?.pageId).toBeNull()
        expect(patch?.status).toBe("REJECTED")
        expect(indexPage?.contentMd).not.toContain(`source-${deletedArticleId}`)
        expect(indexPage?.contentMd).toContain(`source-${keptArticleId}`)
        expect(keptPages).toHaveLength(1)
    })

    it("全量 ingest 能清理已经存在且源文章已删除的 Wiki 页面", async () => {
        const result = await ingestKnowledgeBaseWiki({
            userId,
            knowledgeBaseId: orphanKnowledgeBaseId,
        })

        const orphanPages = await getDb()
            .select({ id: schema.knowledgeBaseWikiPages.id })
            .from(schema.knowledgeBaseWikiPages)
            .where(eq(schema.knowledgeBaseWikiPages.pageKey, "source-999999"))

        expect(orphanPages).toHaveLength(0)
        expect(result.pages).toHaveLength(0)
        expect(result.indexPage.summary).toContain("收录 0 个源文档页面")
        expect(result.warnings).toContain("已清理 1 个失去源文章的 Wiki 页面")
    })
})
