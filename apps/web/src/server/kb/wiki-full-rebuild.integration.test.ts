import { createRequire } from "node:module"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("bun:sqlite")
        return true
    } catch {
        return false
    }
})()

describe.runIf(hasSqlite)("知识库 Wiki 完全重建", () => {
    let getDb: typeof import("@/server/db/client").getDb
    let schema: typeof import("@/server/db/schema")
    let ingestKnowledgeBaseWiki: typeof import("./wiki-agent-logic").ingestKnowledgeBaseWiki
    let userId = 0
    let knowledgeBaseId = 0
    let articleId = 0

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-wiki-full-rebuild-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")
        ;({ ingestKnowledgeBaseWiki } = await import("./wiki-agent-logic"))

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "wiki-full-rebuild@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        userId = user.id

        const [knowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "完全重建测试库",
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
            contentMd: "# 重建测试文章\n\n正文段落。\n\n## 子章节\n\n子章节内容。",
        }).returning({ id: schema.knowledgeBaseArticles.id })
        articleId = article.id
    })

    it("完全重建先清空旧 Wiki，再从源文章重新编译", async () => {
        const db = getDb()

        // 基线：先跑一次增量编译，生成索引页 + 源文档页 + 目录树节点
        const incremental = await ingestKnowledgeBaseWiki({ userId, knowledgeBaseId })
        expect(incremental.purged).toBeNull()

        // 模拟问答补丁沉淀出来的概念页，以及一条待审批补丁
        await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId,
            pageKey: "concept-sedimented",
            title: "问答沉淀页",
            kind: "concept",
            contentMd: "# 问答沉淀页",
            contentHash: "sedimented-hash",
        })
        const [pendingPatch] = await db.insert(schema.knowledgeBaseWikiPatches).values({
            userId,
            knowledgeBaseId,
            pageKey: "concept-pending",
            title: "待审批补丁",
            operation: "CREATE",
            status: "PENDING",
            proposedContentMd: "# 待审批补丁",
            diffText: "测试补丁",
        }).returning({ id: schema.knowledgeBaseWikiPatches.id })

        const pagesBefore = await db
            .select({ id: schema.knowledgeBaseWikiPages.id })
            .from(schema.knowledgeBaseWikiPages)
            .where(and(
                eq(schema.knowledgeBaseWikiPages.userId, userId),
                eq(schema.knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            ))
        const treeNodesBefore = await db
            .select({ id: schema.knowledgeBaseWikiTreeNodes.id })
            .from(schema.knowledgeBaseWikiTreeNodes)
            .where(and(
                eq(schema.knowledgeBaseWikiTreeNodes.userId, userId),
                eq(schema.knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
            ))
        const oldPageIds = new Set(pagesBefore.map((page) => page.id))
        expect(pagesBefore.length).toBeGreaterThan(1)
        expect(treeNodesBefore.length).toBeGreaterThan(0)

        const result = await ingestKnowledgeBaseWiki({ userId, knowledgeBaseId, fullRebuild: true })

        expect(result.purged?.pageCount).toBe(pagesBefore.length)
        expect(result.purged?.treeNodeCount).toBe(treeNodesBefore.length)
        expect(result.pages).toHaveLength(1)

        const pagesAfter = await db
            .select({ id: schema.knowledgeBaseWikiPages.id, pageKey: schema.knowledgeBaseWikiPages.pageKey })
            .from(schema.knowledgeBaseWikiPages)
            .where(and(
                eq(schema.knowledgeBaseWikiPages.userId, userId),
                eq(schema.knowledgeBaseWikiPages.knowledgeBaseId, knowledgeBaseId),
            ))
        const pageKeysAfter = pagesAfter.map((page) => page.pageKey).sort()

        // 索引页和源文档页重新生成，且都是新行；沉淀页不会被重建出来
        expect(pageKeysAfter).toEqual(["index", `source-${articleId}`])
        expect(pagesAfter.every((page) => !oldPageIds.has(page.id))).toBe(true)

        // 子表不残留指向已删除页面的行
        const sourceRefs = await db
            .select({ pageId: schema.knowledgeBaseWikiSourceRefs.pageId })
            .from(schema.knowledgeBaseWikiSourceRefs)
        const links = await db
            .select({ fromPageId: schema.knowledgeBaseWikiLinks.fromPageId })
            .from(schema.knowledgeBaseWikiLinks)
            .where(eq(schema.knowledgeBaseWikiLinks.knowledgeBaseId, knowledgeBaseId))
        const treeNodesAfter = await db
            .select({ pageId: schema.knowledgeBaseWikiTreeNodes.pageId })
            .from(schema.knowledgeBaseWikiTreeNodes)
            .where(and(
                eq(schema.knowledgeBaseWikiTreeNodes.userId, userId),
                eq(schema.knowledgeBaseWikiTreeNodes.knowledgeBaseId, knowledgeBaseId),
            ))

        expect(sourceRefs.every((ref) => !oldPageIds.has(ref.pageId))).toBe(true)
        expect(links.every((link) => !oldPageIds.has(link.fromPageId))).toBe(true)
        expect(treeNodesAfter).toHaveLength(treeNodesBefore.length)
        expect(treeNodesAfter.every((node) => !oldPageIds.has(node.pageId))).toBe(true)

        // 待审批补丁属于用户的审核队列，不随重建清空
        const [patchAfter] = await db
            .select({ status: schema.knowledgeBaseWikiPatches.status })
            .from(schema.knowledgeBaseWikiPatches)
            .where(eq(schema.knowledgeBaseWikiPatches.id, pendingPatch.id))
        expect(patchAfter?.status).toBe("PENDING")

        // 事件日志保留为审计记录：旧记录解除页面引用，本次重建落一条 REBUILD
        const events = await db
            .select({
                eventType: schema.knowledgeBaseWikiEventLogs.eventType,
                pageId: schema.knowledgeBaseWikiEventLogs.pageId,
            })
            .from(schema.knowledgeBaseWikiEventLogs)
            .where(and(
                eq(schema.knowledgeBaseWikiEventLogs.userId, userId),
                eq(schema.knowledgeBaseWikiEventLogs.knowledgeBaseId, knowledgeBaseId),
            ))
        expect(events.filter((event) => event.eventType === "INGEST").every((event) => event.pageId == null)).toBe(true)
        const rebuildEvents = events.filter((event) => event.eventType === "REBUILD")
        expect(rebuildEvents).toHaveLength(1)
        expect(oldPageIds.has(rebuildEvents[0]?.pageId ?? -1)).toBe(false)
    })

    it("文章已清空的知识库完全重建后只剩空索引页", async () => {
        const db = getDb()
        const [emptyKnowledgeBase] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "空库重建测试",
        }).returning({ id: schema.knowledgeBases.id })
        await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId: emptyKnowledgeBase.id,
            pageKey: "source-888888",
            title: "文章已删除",
            kind: "source",
            contentMd: "# 残留内容",
            contentHash: "stale-source-hash",
        })

        const result = await ingestKnowledgeBaseWiki({
            userId,
            knowledgeBaseId: emptyKnowledgeBase.id,
            fullRebuild: true,
        })

        const pagesAfter = await db
            .select({ pageKey: schema.knowledgeBaseWikiPages.pageKey })
            .from(schema.knowledgeBaseWikiPages)
            .where(and(
                eq(schema.knowledgeBaseWikiPages.userId, userId),
                eq(schema.knowledgeBaseWikiPages.knowledgeBaseId, emptyKnowledgeBase.id),
            ))

        expect(result.purged?.pageCount).toBe(1)
        expect(result.pages).toHaveLength(0)
        expect(result.indexPage.summary).toContain("收录 0 个源文档页面")
        expect(pagesAfter.map((page) => page.pageKey)).toEqual(["index"])
    })

    it("完全重建不能与文章范围同时使用", async () => {
        await expect(ingestKnowledgeBaseWiki({
            userId,
            knowledgeBaseId,
            articleIds: [articleId],
            fullRebuild: true,
        })).rejects.toThrow("完全重建会清空整个知识库的 Wiki，不能同时指定文章范围")
    })
})
