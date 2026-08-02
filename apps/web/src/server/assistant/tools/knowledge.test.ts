import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AssistantToolContext } from "../domain-types"

const wikiMocks = vi.hoisted(() => ({
    listUserKnowledgeBases: vi.fn(),
    readSourceArticleForAgent: vi.fn(),
    readWikiPageForAgent: vi.fn(),
    searchWikiPagesAcrossKbs: vi.fn(),
}))

const treeMocks = vi.hoisted(() => ({
    readTreeNodeForAgent: vi.fn(),
    retrieveTreeNodesForAgent: vi.fn(),
    semanticSearchTreeNodes: vi.fn(),
}))

// 星图公开载荷的加载链最终会走到 kb/share-handlers → auth，
// 那里在模块加载期就要求运行时配置；本套件只验证工具契约，直接打桩
const graphMocks = vi.hoisted(() => ({
    loadPublicSiteGraph: vi.fn(),
}))

vi.mock("@/server/kb/wiki-agent-logic", () => wikiMocks)
vi.mock("@/server/kb/wiki-tree", () => treeMocks)
vi.mock("@/server/site-graph/public-graph", () => graphMocks)

import { knowledgeAssistantTools, readKnowledgeNode, searchKnowledge } from "./knowledge"

const baseCtx: AssistantToolContext = {
    userId: 7,
    threadId: 11,
    runId: 13,
    focus: null,
}

function treeHit(nodeKey: string, articleId: string, title = nodeKey) {
    return {
        nodeKey,
        articleId,
        title,
        path: `根 › ${title}`,
        summary: null,
        contentMd: `${title} 原文片段`,
        depth: 1,
    }
}

function findTool(name: string) {
    const registration = knowledgeAssistantTools.find((tool) => tool.name === name)
    if (!registration) throw new Error(`未找到工具：${name}`)
    return registration
}

describe("knowledge assistant tools", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        wikiMocks.listUserKnowledgeBases.mockResolvedValue([])
        wikiMocks.searchWikiPagesAcrossKbs.mockResolvedValue([])
        treeMocks.retrieveTreeNodesForAgent.mockResolvedValue([])
        treeMocks.semanticSearchTreeNodes.mockResolvedValue([])
    })

    it("list_knowledge_bases 只把当前 userId 交给既有归属查询", async () => {
        wikiMocks.listUserKnowledgeBases.mockResolvedValue([{ id: "3", name: "产品", description: null }])

        await expect(findTool("list_knowledge_bases").execute(baseCtx, {})).resolves.toEqual([
            { id: "3", name: "产品", description: null },
        ])
        expect(wikiMocks.listUserKnowledgeBases).toHaveBeenCalledWith(7)
    })

    it("有 focus 时组合树/语义检索，去重后返回可引用 dashboard href", async () => {
        wikiMocks.listUserKnowledgeBases.mockResolvedValue([{ id: "3", name: "产品", description: null }])
        treeMocks.retrieveTreeNodesForAgent.mockResolvedValue([
            treeHit("node-1", "21", "部署"),
        ])
        treeMocks.semanticSearchTreeNodes.mockResolvedValue([
            treeHit("node-1", "21", "部署"),
            treeHit("node-2", "22", "回滚"),
        ])
        const ctx = {
            ...baseCtx,
            focus: { knowledgeBaseId: "3", articleId: "21" },
        }

        const result = await searchKnowledge(ctx, { query: "怎么部署", limit: 8 })

        expect(result).toEqual({
            mode: "tree+semantic",
            knowledgeBaseId: "3",
            knowledgeBaseName: "产品",
            hits: [
                expect.objectContaining({
                    nodeKey: "node-1",
                    href: "/dashboard/knowledge/3/articles/21",
                    snippet: "部署 原文片段",
                }),
                expect.objectContaining({
                    nodeKey: "node-2",
                    href: "/dashboard/knowledge/3/articles/22",
                }),
            ],
        })
        expect(treeMocks.retrieveTreeNodesForAgent).toHaveBeenCalledWith(expect.objectContaining({
            userId: 7,
            knowledgeBaseId: 3,
            articleId: 21,
            maxContentChars: 1600,
        }))
    })

    it("语义检索不可用时静默保留树关键词命中并把 mode 标为 tree", async () => {
        treeMocks.retrieveTreeNodesForAgent.mockResolvedValue([treeHit("node-1", "21", "部署")])
        treeMocks.semanticSearchTreeNodes.mockRejectedValue(new Error("未配置 EMBEDDING"))

        await expect(searchKnowledge(baseCtx, {
            query: "部署",
            knowledgeBaseId: 3,
        })).resolves.toMatchObject({
            mode: "tree",
            knowledgeBaseId: "3",
            hits: [{ nodeKey: "node-1" }],
        })
    })

    it("无库范围时走跨库检索并保留知识库归属", async () => {
        wikiMocks.searchWikiPagesAcrossKbs.mockResolvedValue([{
            knowledgeBaseId: "4",
            knowledgeBaseName: "运维",
            pageKey: "source-31",
            articleId: "31",
            href: "/dashboard/knowledge/4/articles/31",
            title: "发布手册",
            kind: "source",
            summary: "发布步骤",
            updatedAt: "2026-07-10T00:00:00.000Z",
        }])

        await expect(searchKnowledge(baseCtx, { query: "发布" })).resolves.toEqual({
            mode: "cross_kb",
            hits: [{
                knowledgeBaseId: "4",
                knowledgeBaseName: "运维",
                pageKey: "source-31",
                articleId: "31",
                href: "/dashboard/knowledge/4/articles/31",
                title: "发布手册",
                snippet: "发布步骤",
            }],
        })
        expect(wikiMocks.searchWikiPagesAcrossKbs).toHaveBeenCalledWith({
            userId: 7,
            query: "发布",
            limit: 8,
        })
    })

    it("read_knowledge_node 按 nodeKey/pageKey/articleId 三选一分发并标统一 kind", async () => {
        treeMocks.readTreeNodeForAgent.mockResolvedValue({
            nodeKey: "node-1",
            articleId: "21",
            title: "部署",
            contentMd: "正文",
        })
        wikiMocks.readWikiPageForAgent.mockResolvedValue({
            knowledgeBaseId: "3",
            pageKey: "source-21",
            articleId: "21",
            href: "/dashboard/knowledge/3/articles/21",
            title: "部署页",
            kind: "source",
            contentMd: "Wiki 正文",
            media: [],
            sourceRefs: [],
            links: [],
        })
        wikiMocks.readSourceArticleForAgent.mockResolvedValue({
            knowledgeBaseId: "3",
            articleId: "21",
            href: "/dashboard/knowledge/3/articles/21",
            title: "部署原文",
            contentMd: "原文",
            media: [],
            updatedAt: "2026-07-10T00:00:00.000Z",
        })
        const ctx = { ...baseCtx, focus: { knowledgeBaseId: "3" } }

        await expect(readKnowledgeNode(ctx, { nodeKey: "node-1" })).resolves.toMatchObject({
            kind: "tree_node",
            href: "/dashboard/knowledge/3/articles/21",
        })
        await expect(readKnowledgeNode(ctx, { pageKey: "source-21" })).resolves.toMatchObject({
            kind: "wiki_page",
            pageKind: "source",
        })
        await expect(readKnowledgeNode(ctx, { articleId: 21 })).resolves.toMatchObject({
            kind: "article",
            title: "部署原文",
        })
    })

    it("read_knowledge_node schema 强制三选一，且三个工具均为 knowledge/read", () => {
        const schema = findTool("read_knowledge_node").inputSchema
        expect(() => schema.parse({ knowledgeBaseId: 3 })).toThrow()
        expect(() => schema.parse({ knowledgeBaseId: 3, nodeKey: "n", articleId: 1 })).toThrow()
        expect(schema.parse({ knowledgeBaseId: 3, pageKey: "source-1" })).toMatchObject({ pageKey: "source-1" })
        expect(findTool("read_knowledge_node").description).toContain("media")
        expect(knowledgeAssistantTools.map(({ name, domain, risk }) => ({ name, domain, risk }))).toEqual([
            { name: "list_knowledge_bases", domain: "knowledge", risk: "read" },
            { name: "search_knowledge", domain: "knowledge", risk: "read" },
            { name: "search_knowledge_graph", domain: "knowledge", risk: "read" },
            { name: "read_knowledge_node", domain: "knowledge", risk: "read" },
        ])
    })
})
