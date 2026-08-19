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
import { knowledgeTools } from "./knowledge"

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
