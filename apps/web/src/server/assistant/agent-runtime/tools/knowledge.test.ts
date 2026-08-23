import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    readKnowledgeNode: vi.fn(),
    recallKnowledgeCandidates: vi.fn(),
    recallKnowledgeCandidatesAcrossKbs: vi.fn(),
}))

vi.mock("../../tools/knowledge", () => ({ readKnowledgeNode: mocks.readKnowledgeNode }))
vi.mock("@/server/kb/knowledge-recall", () => ({
    recallKnowledgeCandidates: mocks.recallKnowledgeCandidates,
    recallKnowledgeCandidatesAcrossKbs: mocks.recallKnowledgeCandidatesAcrossKbs,
}))
vi.mock("@/server/kb/wiki-agent-logic", () => ({
    listUserKnowledgeBases: vi.fn(async () => []),
    searchWikiPagesAcrossKbs: vi.fn(async () => []),
}))

import type { ToolExecutionContext } from "../types"
import { knowledgeTools, wikiQaTools } from "./knowledge"

function context(complexity: "simple" | "complex" = "simple"): ToolExecutionContext {
    return {
        runId: "run-1",
        userId: 7,
        conversationId: "conversation-1",
        delegationDepth: 0,
        state: {
            complexity,
        },
    } as ToolExecutionContext
}

describe("knowledge.read_many", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.readKnowledgeNode.mockImplementation(async (_ctx, input: { nodeKey: string }) => ({
            kind: "tree_node",
            knowledgeBaseId: "1",
            articleId: "10",
            nodeKey: input.nodeKey,
            title: `章节 ${input.nodeKey}`,
            path: `文章 › 章节 ${input.nodeKey}`,
            contentMd: `正文 ${input.nodeKey}`,
            contextMd: "上级章节：文章摘要",
            contentFrom: "node",
        }))
    })

    it("简单问题一次并行深读最多两个章节，并产出两条独立证据", async () => {
        const tool = knowledgeTools.find((item) => item.id === "knowledge.read_many")!
        const output = await tool.execute(context("simple"), {
            nodes: [
                { knowledgeBaseId: 1, nodeKey: "n1" },
                { knowledgeBaseId: 1, nodeKey: "n2" },
                { knowledgeBaseId: 1, nodeKey: "n3" },
            ],
        })
        const normalized = tool.normalize!(output, {})

        expect(mocks.readKnowledgeNode).toHaveBeenCalledTimes(2)
        expect(normalized.evidence).toHaveLength(2)
        expect(normalized.summary).toContain("并行深读 2 个相关章节")
        expect(normalized.summary).toContain("跳过 1 个低优先级候选")
        expect(normalized.evidence?.[0].sourceId).toBe("n1")
        expect(normalized.evidence?.[0].content).toContain("[章节定位上下文]")
    })

    it("复杂问题允许一次并行深读四个章节", async () => {
        const tool = knowledgeTools.find((item) => item.id === "knowledge.read_many")!
        const output = await tool.execute(context("complex"), {
            nodes: ["n1", "n2", "n3", "n4"].map((nodeKey) => ({ knowledgeBaseId: 1, nodeKey })),
        })
        const normalized = tool.normalize!(output, {})

        expect(mocks.readKnowledgeNode).toHaveBeenCalledTimes(4)
        expect(normalized.evidence).toHaveLength(4)
    })
})

describe("knowledge.lookup", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.recallKnowledgeCandidatesAcrossKbs.mockResolvedValue({
            candidates: [
                {
                    nodeKey: "n1",
                    articleId: "10",
                    knowledgeBaseId: "1",
                    title: "小鼹鼠",
                    summary: "Mole 工具",
                    score: 0.12,
                    rerankScore: 12,
                    recallSources: ["vector", "bm25"],
                },
                {
                    nodeKey: "n2",
                    articleId: "10",
                    knowledgeBaseId: "1",
                    title: "什么是 Mole",
                    summary: "定义",
                    score: 0.08,
                    rerankScore: 10,
                    recallSources: ["vector", "bm25"],
                },
                {
                    nodeKey: "n3",
                    articleId: "10",
                    knowledgeBaseId: "1",
                    title: "更多内容",
                    summary: "低优先级",
                    score: 0.02,
                    rerankScore: 1,
                    recallSources: ["vector"],
                },
            ],
            diagnostics: {
                vectorKeys: ["1:n1", "1:n2"],
                bm25Keys: ["1:n1", "1:n2"],
                treeKeys: [],
                treeAttempted: false,
                rerankStrategy: "local",
                degraded: {},
                retrievalMs: 30,
                rerankMs: 0,
            },
        })
        mocks.readKnowledgeNode.mockImplementation(async (_ctx, input: { nodeKey: string }) => ({
            kind: "tree_node",
            knowledgeBaseId: "1",
            articleId: "10",
            nodeKey: input.nodeKey,
            title: `章节 ${input.nodeKey}`,
            path: `文章 › 章节 ${input.nodeKey}`,
            contentMd: `正文 ${input.nodeKey}`,
            contextMd: "上级章节：文章摘要",
            contentFrom: "node",
        }))
    })

    it("一次完成跨库检索和两个章节深读，并保留独立来源", async () => {
        const tool = knowledgeTools.find((item) => item.id === "knowledge.lookup")!
        const output = await tool.execute(context("simple"), { query: "小鼹鼠是什么" })
        const normalized = tool.normalize!(output, { query: "小鼹鼠是什么" })

        expect(mocks.recallKnowledgeCandidatesAcrossKbs).toHaveBeenCalledTimes(1)
        expect(mocks.readKnowledgeNode).toHaveBeenCalledTimes(2)
        expect(normalized.evidence).toHaveLength(2)
        expect(normalized.evidence?.map((item) => item.sourceId)).toEqual(["n1", "n2"])
        expect(normalized.summary).toContain("找到 3 个相关章节并深读 2 个")
        expect(normalized.summary).toContain("Wiki 目录导航未参与")
        expect(normalized.summary).toContain("本地重排")
    })

    it("深读名额全被分片占据时，保底换入一个 Wiki 页面读取", async () => {
        mocks.recallKnowledgeCandidatesAcrossKbs.mockResolvedValue({
            candidates: [
                {
                    chunkId: "501",
                    articleId: "10",
                    knowledgeBaseId: "1",
                    title: "分片一",
                    summary: "正文片段",
                    score: 0.12,
                    rerankScore: 12,
                    recallSources: ["vector"],
                },
                {
                    chunkId: "502",
                    articleId: "10",
                    knowledgeBaseId: "1",
                    title: "分片二",
                    summary: "正文片段",
                    score: 0.08,
                    rerankScore: 10,
                    recallSources: ["vector"],
                },
                {
                    pageKey: "concept-mole",
                    knowledgeBaseId: "1",
                    title: "Mole",
                    summary: "概念页",
                    score: 0.02,
                    rerankScore: 1,
                    recallSources: ["bm25"],
                },
            ],
            diagnostics: {
                chunkVectorKeys: ["1:501"],
                bm25Keys: ["1:501"],
                questionVectorKeys: [],
                wikiKeys: ["1:concept-mole"],
                vectorKeys: [],
                treeKeys: [],
                treeAttempted: false,
                rerankStrategy: "local",
                degraded: {},
            },
        })
        mocks.readKnowledgeNode.mockImplementation(async (_ctx, input: { pageKey?: string; chunkId?: string | number }) => ({
            kind: input.pageKey ? "wiki_page" : "article_chunk",
            knowledgeBaseId: "1",
            ...(input.pageKey ? { pageKey: input.pageKey } : { chunkId: String(input.chunkId) }),
            title: input.pageKey ? "Mole" : "分片",
            contentMd: "正文",
        }))

        const tool = knowledgeTools.find((item) => item.id === "knowledge.lookup")!
        const output = await tool.execute(context("simple"), { query: "小鼹鼠是什么" })
        const normalized = tool.normalize!(output, { query: "小鼹鼠是什么" })

        // 第二个名额被换成排名最高的 Wiki 页面，证据里才有可引用的 pageKey
        const calledInputs = mocks.readKnowledgeNode.mock.calls.map(([, input]) => input)
        expect(calledInputs).toContainEqual(expect.objectContaining({ pageKey: "concept-mole" }))
        const wikiEvidence = normalized.evidence?.find((item) => item.metadata?.pageKey === "concept-mole")
        expect(wikiEvidence).toBeTruthy()
        expect(wikiEvidence?.sourceId).toBe("concept-mole")
    })
})

/**
 * 章节里的图片要能进到「模型看得见的那段证据」里。
 *
 * 两个真实约束叠在一起：
 * - readTreeNodeForAgent 会返回 media（从正文抽出的 s4key: 引用），
 *   但模型只读 evidence.content，不读工具的 data 字段；
 * - mastra-bridge 给模型的单条证据只截前 1,200 字（MODEL_EVIDENCE_ITEM_MAX_CHARS）。
 *
 * 所以"图片语法本来就在正文里"并不够：章节稍长图片就落在窗口外，
 * 模型只看得到图片上下的文字——正是「只返回了图片上的文字和图片下的文字」。
 */
describe("knowledge.read 的媒体透传", () => {
    /** 与 mastra-bridge 的 MODEL_EVIDENCE_ITEM_MAX_CHARS 保持一致 */
    const MODEL_EVIDENCE_ITEM_MAX_CHARS = 1_200
    const readTool = knowledgeTools.find((tool) => tool.id === "knowledge.read")

    const nodeOutput = () => ({
        kind: "tree_node",
        title: "安装与配置",
        nodeKey: "a1-3",
        articleId: "1",
        knowledgeBaseId: "2",
        contentFrom: "node",
        breadcrumb: ["文档", "安装与配置"],
        // 图片前有较长正文，图片本身落在 1,200 字窗口之外
        contentMd: [
            "图片上方的说明文字。".repeat(120),
            "",
            "![部署架构图](s4key:kb/1/arch-diagram.png)",
            "",
            "图片下方的补充说明。".repeat(10),
        ].join("\n"),
        media: [{
            id: "image-1",
            kind: "image",
            alt: "部署架构图",
            src: "s4key:kb/1/arch-diagram.png",
            objectKey: "kb/1/arch-diagram.png",
            filename: "arch-diagram.png",
        }],
    })

    it("模型可见的证据窗口里带得到图片引用", () => {
        expect(readTool?.normalize).toBeTypeOf("function")
        const result = readTool!.normalize!(nodeOutput(), { nodeKey: "a1-3" })
        const content = result.evidence?.[0]?.content ?? ""
        expect(content.slice(0, MODEL_EVIDENCE_ITEM_MAX_CHARS))
            .toContain("s4key:kb/1/arch-diagram.png")
    })

    it("媒体清单也进 data，便于观测与前端复用", () => {
        const result = readTool!.normalize!(nodeOutput(), { nodeKey: "a1-3" })
        const data = result.data as { media?: Array<{ src: string }> }
        expect(data.media?.[0]?.src).toBe("s4key:kb/1/arch-diagram.png")
    })

    it("没有媒体时不加噪声", () => {
        const { media: _media, ...withoutMedia } = nodeOutput()
        const result = readTool!.normalize!(withoutMedia, { nodeKey: "a1-3" })
        expect(result.evidence?.[0]?.content ?? "").not.toContain("可引用的媒体")
        expect((result.data as { media?: unknown }).media).toBeUndefined()
    })
})

/**
 * "读全文"就必须是全文。
 *
 * 工具说明与 Wiki 问答提示词都写着 read_wiki_page_detail 读全文，summary 里也报了真实字数。
 * 若正文在归一化时被悄悄裁到 4,000 字，模型会发现字数对不上，判定"Wiki 页面内容被截断了"，
 * 转而去读源文档——多烧两次工具调用，答案还更粗。
 */
describe("Wiki 全文读取不裁剪", () => {
    /** 旧实现在这里切一刀 */
    const LEGACY_EVIDENCE_MAX_CHARS = 4_000
    const longBody = "Wiki 正文段落。".repeat(800)

    it("read_wiki_page_detail 把整页正文交给证据，并标记为全文读取", () => {
        const tool = wikiQaTools.find((item) => item.id === "knowledge.read_wiki_page_detail")!
        const result = tool.normalize!({
            pageKey: "source-8",
            title: "Fastfetch 使用说明文档",
            kind: "source",
            contentMd: `${longBody}\n\n## 来源\n- 源文档 ID：8`,
            links: [],
            inLinks: [],
            sourceArticles: [],
        }, { pageKey: "source-8" })

        const evidence = result.evidence?.[0]
        expect(evidence?.content.length).toBeGreaterThan(LEGACY_EVIDENCE_MAX_CHARS)
        expect(evidence?.fullRead).toBe(true)
        // 尾部的来源段最容易被旧上限切掉
        expect(evidence?.content).toContain("源文档 ID：8")
        expect(result.summary).toContain(String(`${longBody}\n\n## 来源\n- 源文档 ID：8`.length))
    })

    it("read_knowledge_node 传 pageKey 读到的整页同样不裁剪", () => {
        const tool = knowledgeTools.find((item) => item.id === "knowledge.read")!
        const result = tool.normalize!({
            kind: "wiki_page",
            pageKind: "source",
            title: "Fastfetch 使用说明文档",
            pageKey: "source-8",
            knowledgeBaseId: "1",
            contentMd: longBody,
        }, { pageKey: "source-8" })

        const evidence = result.evidence?.[0]
        expect(evidence?.content.length).toBeGreaterThan(LEGACY_EVIDENCE_MAX_CHARS)
        expect(evidence?.fullRead).toBe(true)
        expect(evidence?.content).toContain("[Wiki 页面正文]")
        // 普通问答也要能内联 [[pageKey|标题]]：证据必须带 pageKey（渲染「Wiki 引用」提示），
        // 且 sourceId 与 read_wiki_page_detail 同口径，两种读取方式命中同一页面时可去重合并
        expect(evidence?.metadata?.pageKey).toBe("source-8")
        expect(evidence?.sourceId).toBe("source-8")
    })

    it("章节深读仍按片段上限裁剪，不受影响", () => {
        const tool = knowledgeTools.find((item) => item.id === "knowledge.read")!
        const result = tool.normalize!({
            kind: "tree_node",
            title: "安装与配置",
            nodeKey: "a1-3",
            articleId: "1",
            knowledgeBaseId: "1",
            contentFrom: "node",
            contentMd: longBody,
        }, { nodeKey: "a1-3" })

        const evidence = result.evidence?.[0]
        expect(evidence?.content.length).toBe(LEGACY_EVIDENCE_MAX_CHARS)
        expect(evidence?.fullRead).toBeUndefined()
    })
})
