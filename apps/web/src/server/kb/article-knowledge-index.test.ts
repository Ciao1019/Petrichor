import { describe, expect, it } from "vitest"

import { ARTICLE_KNOWLEDGE_INDEX_VERSION, buildArticleKnowledgeIndexValues } from "./article-knowledge-index"

describe("文章知识检索条目", () => {
    it("先产出全部原始分片，再产出逐片推荐问题，并全部指回原分片", () => {
        const now = new Date("2026-08-21T00:00:00.000Z")
        const values = buildArticleKnowledgeIndexValues({
            userId: 1,
            knowledgeBaseId: 2,
            articleId: 3,
            articleTitle: "部署手册",
            now,
            chunks: [
                {
                    id: 11,
                    chunkKey: "chunk-001",
                    heading: "回滚",
                    headingPathJson: JSON.stringify(["发布", "回滚"]),
                    contentMd: "执行 rollback 命令。",
                    recommendedQuestionsJson: JSON.stringify(["如何回滚？", "回滚命令是什么？"]),
                },
                {
                    id: 12,
                    chunkKey: "chunk-002",
                    heading: "监控",
                    headingPathJson: "[]",
                    contentMd: "观察错误率。",
                    recommendedQuestionsJson: JSON.stringify(["发布后看什么指标？"]),
                },
            ],
        })

        expect(values.map((item) => item.sourceType)).toEqual([
            "chunk", "chunk", "question", "question", "question",
        ])
        expect(values.map((item) => item.chunkId)).toEqual([11, 12, 11, 11, 12])
        expect(values.map((item) => item.sourceKey)).toEqual([
            "chunk-001:chunk",
            "chunk-002:chunk",
            "chunk-001:question:0",
            "chunk-001:question:1",
            "chunk-002:question:0",
        ])
        expect(values[0]?.embeddingText).toContain("部署手册\n发布 > 回滚\n执行 rollback 命令。")
        expect(values[2]?.embeddingText).toContain("部署手册\n发布 > 回滚\n如何回滚？")
        expect(values.every((item) => item.searchTokens.length > 0)).toBe(true)
        expect(values.every((item) => item.embeddingVersion === ARTICLE_KNOWLEDGE_INDEX_VERSION)).toBe(true)
        expect(values.every((item) => item.embeddingStatus === "pending" && item.updatedAt === now)).toBe(true)
    })
})
