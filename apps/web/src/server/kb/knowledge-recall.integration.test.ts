import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("better-sqlite3")
        return true
    } catch {
        return false
    }
})()

describe.runIf(hasSqlite)("knowledge recall integration", () => {
    let getDb: typeof import("@/server/db/client").getDb
    let schema: typeof import("@/server/db/schema")
    let recallAcross: typeof import("./knowledge-recall").recallKnowledgeCandidatesAcrossKbs
    let recallFocused: typeof import("./knowledge-recall").recallKnowledgeCandidates
    let userId = 0
    let knowledgeBaseId = 0
    let targetKey = ""

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-recall-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")
        ;({ recallKnowledgeCandidatesAcrossKbs: recallAcross, recallKnowledgeCandidates: recallFocused }
            = await import("./knowledge-recall"))

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "recall@example.test",
            passwordHash: "test-only",
        }).returning({ id: schema.users.id })
        userId = user.id
        const [kb] = await db.insert(schema.knowledgeBases).values({ userId, name: "旧资料库" })
            .returning({ id: schema.knowledgeBases.id })
        knowledgeBaseId = kb.id
        const [folder] = await db.insert(schema.knowledgeBaseNodes).values({
            userId,
            knowledgeBaseId,
            name: "根",
            type: "FOLDER",
        }).returning({ id: schema.knowledgeBaseNodes.id })
        const [article] = await db.insert(schema.knowledgeBaseArticles).values({
            userId,
            knowledgeBaseId,
            nodeId: folder.id,
            title: "历史部署记录",
            contentMd: "Sentinel 冷门术语只存在于很早的章节。",
        }).returning({ id: schema.knowledgeBaseArticles.id })
        const [page] = await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId,
            pageKey: "history",
            title: "历史部署记录",
            kind: "source",
            contentMd: "历史页面",
            contentHash: "history-page",
        }).returning({ id: schema.knowledgeBaseWikiPages.id })

        targetKey = `article-${article.id}:target`
        const rows = [
            {
                userId,
                knowledgeBaseId,
                pageId: page.id,
                articleId: article.id,
                nodeKey: targetKey,
                depth: 0,
                position: 0,
                title: "Sentinel 冷门术语",
                summary: "只存在于旧章节的精确答案",
                contentMd: "生产环境使用 Sentinel，并配置故障转移。",
                contentHash: "target",
            },
            ...Array.from({ length: 520 }, (_value, index) => ({
                userId,
                knowledgeBaseId,
                pageId: page.id,
                articleId: article.id,
                nodeKey: `article-${article.id}:decoy-${index}`,
                depth: 0,
                position: index + 1,
                title: `无关章节 ${index}`,
                summary: "普通说明",
                contentMd: "这里没有目标关键词。",
                contentHash: `decoy-${index}`,
            })),
        ]
        await db.insert(schema.knowledgeBaseWikiTreeNodes).values(rows)
    })

    it("跨库召回不再受最近 500 条扫描上限影响", async () => {
        const result = await recallAcross({
            userId,
            query: "Sentinel 冷门术语",
            limit: 5,
        })

        expect(result.candidates[0]).toMatchObject({
            nodeKey: targetKey,
            knowledgeBaseId: String(knowledgeBaseId),
        })
        expect(result.diagnostics.bm25Keys).toContain(`${knowledgeBaseId}:${targetKey}`)
    })

    it("fallback 模式在 BM25 已命中时不会启动 Tree LLM", async () => {
        const result = await recallFocused({
            userId,
            knowledgeBaseId,
            query: "Sentinel 冷门术语",
            treeMode: "fallback",
        })

        expect(result.candidates.some((item) => item.nodeKey === targetKey)).toBe(true)
        expect(result.diagnostics.treeAttempted).toBe(false)
        expect(result.diagnostics.degraded.vector).toBeTruthy()
    })
})
