import { describe, expect, it } from "vitest"
import type { KnowledgeCandidate } from "./knowledge-recall"
import { selectArticleStage, selectDiverseCandidates } from "./knowledge-recall"

function candidate(
    nodeKey: string,
    articleId: string,
    score: number,
    overrides: Partial<KnowledgeCandidate & { content?: string }> = {},
): KnowledgeCandidate & { content?: string } {
    return {
        nodeKey,
        articleId,
        knowledgeBaseId: "1",
        title: nodeKey,
        score,
        recallSources: ["bm25"],
        ...overrides,
    }
}

describe("两阶段知识召回", () => {
    it("先按文章聚合，再均衡选取文章内章节", () => {
        const result = selectArticleStage([
            candidate("a-1", "10", 0.9),
            candidate("a-2", "10", 0.8),
            candidate("a-3", "10", 0.7),
            candidate("b-1", "20", 0.75, { recallSources: ["vector", "bm25"] }),
            candidate("b-2", "20", 0.6),
            candidate("c-1", "30", 0.1),
        ], { articleTopK: 2, perArticleTopK: 2 })

        expect(result.articleIds).toHaveLength(2)
        expect(result.candidates.map((item) => item.nodeKey)).toEqual(["a-1", "b-1", "a-2", "b-2"])
    })

    it("最终结果过滤同篇过多章节和高度重复正文", () => {
        const result = selectDiverseCandidates([
            candidate("a-1", "10", 1, { title: "安装", content: "使用 brew install mole 完成安装" }),
            candidate("a-2", "10", 0.9, { title: "安装", content: "使用 brew install mole 完成安装" }),
            candidate("a-3", "10", 0.8, { title: "配置", content: "编辑配置文件" }),
            candidate("b-1", "20", 0.7, { title: "核心功能", content: "缓存清理与卸载" }),
        ], 4, 2)

        expect(result.items.map((item) => item.nodeKey)).toEqual(["a-1", "a-3", "b-1"])
        expect(result.droppedKeys).toContain("1:a-2")
    })
})
