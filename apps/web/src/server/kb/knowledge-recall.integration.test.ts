import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"

const hasSqlite = (() => {
    try {
        createRequire(import.meta.url)("bun:sqlite")
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
    let readTreeNode: typeof import("./wiki-tree").readTreeNodeForAgent
    let readChunk: typeof import("./article-knowledge-index").readArticleKnowledgeChunkForAgent
    let userId = 0
    let knowledgeBaseId = 0
    let modernChunkId = 0
    let targetKey = ""
    let emptyParentKey = ""

    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-recall-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")
        ;({ recallKnowledgeCandidatesAcrossKbs: recallAcross, recallKnowledgeCandidates: recallFocused }
            = await import("./knowledge-recall"))
        ;({ readTreeNodeForAgent: readTreeNode } = await import("./wiki-tree"))
        ;({ readArticleKnowledgeChunkForAgent: readChunk } = await import("./article-knowledge-index"))

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
            contentMd: "Sentinel 冷门术语只存在于很早的章节。整篇文章独有标记不应出现在空父章节读取结果中。",
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

        const [modernChunk] = await db.insert(schema.knowledgeBaseArticleChunks).values({
            userId,
            knowledgeBaseId,
            articleId: article.id,
            chunkKey: "chunk-recovery",
            position: 0,
            heading: "灾备恢复",
            headingPathJson: JSON.stringify(["运维", "灾备恢复"]),
            contentMd: "冷备节点切换前必须校验 WAL 追平，并在切流后检查写入延迟。",
            contentHash: "modern-chunk",
            recommendedQuestionsJson: JSON.stringify(["液压鲲鹏故障时如何恢复服务？"]),
        }).returning({ id: schema.knowledgeBaseArticleChunks.id })
        modernChunkId = modernChunk.id

        const { buildArticleKnowledgeIndexValues } = await import("./article-knowledge-index")
        await db.insert(schema.knowledgeBaseArticleChunkIndexes).values(buildArticleKnowledgeIndexValues({
            userId,
            knowledgeBaseId,
            articleId: article.id,
            articleTitle: "历史部署记录",
            chunks: [{
                id: modernChunk.id,
                chunkKey: "chunk-recovery",
                heading: "灾备恢复",
                headingPathJson: JSON.stringify(["运维", "灾备恢复"]),
                contentMd: "冷备节点切换前必须校验 WAL 追平，并在切流后检查写入延迟。",
                recommendedQuestionsJson: JSON.stringify(["液压鲲鹏故障时如何恢复服务？"]),
            }],
        }))
        await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId,
            pageKey: "concept-wal-failover",
            title: "WAL 故障转移",
            kind: "concept",
            summary: "解释 WAL 追平与故障转移之间的关系。",
            contentMd: "# WAL 故障转移\n\n概念页用于理解恢复策略，精确步骤应回读原文分片。",
            contentHash: "concept-wal-failover",
        })

        targetKey = `article-${article.id}:target`
        emptyParentKey = `article-${article.id}:empty-parent`
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
            {
                userId,
                knowledgeBaseId,
                pageId: page.id,
                articleId: article.id,
                nodeKey: emptyParentKey,
                depth: 0,
                position: 1,
                title: "安装指南",
                summary: "安装相关内容的父章节",
                contentMd: "",
                contentHash: "empty-parent",
            },
            {
                userId,
                knowledgeBaseId,
                pageId: page.id,
                articleId: article.id,
                nodeKey: `article-${article.id}:child-install`,
                parentKey: emptyParentKey,
                depth: 1,
                position: 2,
                title: "使用 Homebrew 安装",
                summary: "通过 Homebrew 安装",
                contentMd: "运行 brew install mole。",
                contentHash: "child-install",
            },
            {
                userId,
                knowledgeBaseId,
                pageId: page.id,
                articleId: article.id,
                nodeKey: `article-${article.id}:outside-subtree`,
                depth: 0,
                position: 3,
                title: "卸载指南",
                summary: "与安装子树无关",
                contentMd: "这是空父章节子树以外的内容。",
                contentHash: "outside-subtree",
            },
            ...Array.from({ length: 520 }, (_value, index) => ({
                userId,
                knowledgeBaseId,
                pageId: page.id,
                articleId: article.id,
                nodeKey: `article-${article.id}:decoy-${index}`,
                depth: 0,
                position: index + 10,
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

    it("空父章节只聚合子树，不再回退整篇文章", async () => {
        const result = await readTreeNode(userId, knowledgeBaseId, emptyParentKey)

        expect(result?.contentFrom).toBe("subtree")
        expect(result?.contentMd).toContain("使用 Homebrew 安装")
        expect(result?.contentMd).toContain("brew install mole")
        expect(result?.contentMd).not.toContain("整篇文章独有标记")
        expect(result?.contentMd).not.toContain("空父章节子树以外的内容")
        expect(result?.contextMd).toContain("直接子章节")
    })

    it("问题命中映射回对应原文分片", async () => {
        const result = await recallFocused({
            userId,
            knowledgeBaseId,
            query: "液压鲲鹏故障如何恢复",
        })

        expect(result.candidates[0]).toMatchObject({
            candidateKind: "chunk",
            chunkId: String(modernChunkId),
        })
        expect(result.candidates[0]?.recallSources).toContain("question_bm25")

        const evidence = await readChunk(userId, knowledgeBaseId, modernChunkId)
        expect(evidence?.contentMd).toContain("WAL 追平")
    })

    it("Wiki 概念页作为独立检索面参与召回", async () => {
        const result = await recallFocused({
            userId,
            knowledgeBaseId,
            query: "WAL 故障转移关系",
        })

        expect(result.candidates.some((item) => (
            item.candidateKind === "wiki"
            && item.pageKey === "concept-wal-failover"
            && item.recallSources.includes("wiki")
        ))).toBe(true)
        expect(result.diagnostics.wikiKeys).toContain(`wiki:${knowledgeBaseId}:concept-wal-failover`)
    })
})
