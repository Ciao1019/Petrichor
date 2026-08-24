import { createRequire } from "node:module"
import { asc, eq } from "drizzle-orm"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

type MockDoStream = NonNullable<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doStream"]>
type LanguageModelStreamResult = Extract<MockDoStream, { stream: unknown }>

const runtimeMocks = vi.hoisted(() => ({
    createChatLanguageModel: vi.fn(),
    requireCurrentUser: vi.fn(),
}))

vi.mock("@/server/ai/generation", () => ({
    createChatLanguageModel: runtimeMocks.createChatLanguageModel,
}))
vi.mock("@/server/auth/current-user", () => ({
    requireCurrentUser: runtimeMocks.requireCurrentUser,
}))

// 原先按 Node ABI 版本号硬编码，换个 Node 版本就整组静默跳过。
// 改成按"能不能真的加载 bun:sqlite"判断，保证该跑的时候一定会跑。
const runIntegration = (() => {
    try {
        createRequire(import.meta.url)("bun:sqlite")
        return true
    } catch {
        return false
    }
})()

let assistantChat: typeof import("../chat-handler").assistantChat
let getDb: typeof import("@/server/db/client").getDb
let schema: typeof import("@/server/db/schema")
let userId = 0
let knowledgeBaseId = 0
let articleId = 0
let treeNodeKey = ""
let docLibraryId = 0
let documentId = 0

const usage = {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 3, text: 3, reasoning: undefined },
}

function toolCallStream(toolCallId: string, toolName: string, input: unknown): LanguageModelStreamResult {
    return {
        stream: simulateReadableStream({
            chunks: [
                { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
        }),
    }
}

function textStream(text: string): LanguageModelStreamResult {
    return {
        stream: simulateReadableStream({
            chunks: [
                { type: "text-start", id: "text-1" },
                { type: "text-delta", id: "text-1", delta: text },
                { type: "text-end", id: "text-1" },
                { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
        }),
    }
}

function requestWith(body: unknown) {
    return {
        json: async () => body,
        signal: new AbortController().signal,
        nextUrl: { pathname: "/api/assistant/chat" },
    } as Parameters<typeof assistantChat>[0]
}

function setMockModel(streams: LanguageModelStreamResult[]) {
    const model = new MockLanguageModelV4({ doStream: streams })
    // 形状必须对齐 createChatLanguageModel 的真实返回：{ resolved, model }。
    // 这里之前是 { model, config }，因为测试长期被 ABI 门控跳过而无人发现。
    runtimeMocks.createChatLanguageModel.mockResolvedValue({
        model,
        resolved: {
            model: { id: 501, modelId: "mock-model", name: "mock" },
            provider: { providerKey: "openai-compatible" },
            credential: {},
            options: {},
            runtime: {},
        },
    })
    return model
}

async function loadRunEvidence(response: Response) {
    const runId = Number(response.headers.get("X-Petrichor-Assistant-Run-Id"))
    const [run] = await getDb()
        .select()
        .from(schema.assistantRuns)
        .where(eq(schema.assistantRuns.id, runId))
    const steps = await getDb()
        .select()
        .from(schema.assistantSteps)
        .where(eq(schema.assistantSteps.runId, runId))
        .orderBy(asc(schema.assistantSteps.stepIndex))
    return { run: run!, runId, steps }
}

describe.runIf(runIntegration)("assistant chat handler integration", () => {
    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-agent-tools-handler-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"

        ;({ assistantChat } = await import("../chat-handler"))
        ;({ getDb } = await import("@/server/db/client"))
        schema = await import("@/server/db/schema")

        const db = getDb()
        const [user] = await db.insert(schema.users).values({
            email: "assistant-handler@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        const [otherUser] = await db.insert(schema.users).values({
            email: "assistant-handler-other@example.test",
            passwordHash: "integration-test-only",
        }).returning({ id: schema.users.id })
        userId = user!.id
        const [kb] = await db.insert(schema.knowledgeBases).values({
            userId,
            name: "隔离知识库",
            description: "handler 集成测试",
        }).returning({ id: schema.knowledgeBases.id })
        knowledgeBaseId = kb!.id
        const [node] = await db.insert(schema.knowledgeBaseNodes).values({
            userId,
            knowledgeBaseId,
            parentId: null,
            type: "ARTICLE",
            name: "部署手册",
            sortOrder: 0,
        }).returning({ id: schema.knowledgeBaseNodes.id })
        const [article] = await db.insert(schema.knowledgeBaseArticles).values({
            userId,
            knowledgeBaseId,
            nodeId: node!.id,
            title: "部署手册",
            contentMd: "# 部署\n先构建，再发布。失败时执行回滚。",
        }).returning({ id: schema.knowledgeBaseArticles.id })
        articleId = article!.id
        const [page] = await db.insert(schema.knowledgeBaseWikiPages).values({
            userId,
            knowledgeBaseId,
            pageKey: `source-${articleId}`,
            title: "部署手册",
            kind: "source",
            contentMd: "# 部署\n先构建，再发布。失败时执行回滚。",
            summary: "部署与回滚步骤",
            contentHash: "handler-page-hash",
        }).returning({ id: schema.knowledgeBaseWikiPages.id })
        treeNodeKey = `article-${articleId}:h1-deploy`
        await db.insert(schema.knowledgeBaseWikiTreeNodes).values({
            userId,
            knowledgeBaseId,
            pageId: page!.id,
            articleId,
            nodeKey: treeNodeKey,
            parentKey: null,
            depth: 0,
            position: 0,
            title: "部署与回滚",
            summary: "失败时执行回滚",
            contentMd: "先构建，再发布。失败时执行回滚。",
            tokenEstimate: 12,
            contentHash: "handler-node-hash",
        })
        await db.insert(schema.knowledgeBases).values({
            userId: otherUser!.id,
            name: "其他用户知识库",
            description: "不可见",
        })

        const [library] = await db.insert(schema.docLibraries).values({
            userId,
            name: "发布文档库",
            description: "当前用户",
            documentCount: 1,
        }).returning({ id: schema.docLibraries.id })
        docLibraryId = library!.id
        await db.insert(schema.docLibraries).values({
            userId: otherUser!.id,
            name: "其他用户文档库",
            description: "不可见",
            documentCount: 0,
        })
        const [document] = await db.insert(schema.docDocuments).values({
            userId,
            libraryId: docLibraryId,
            folderId: null,
            fileName: "deploy.pdf",
            title: "部署与回滚文档",
            fileType: "pdf",
            objectKey: `uploads/${userId}/deploy.pdf`,
            status: "ready",
        }).returning({ id: schema.docDocuments.id })
        documentId = document!.id
        await db.insert(schema.docChunks).values([
            {
                userId,
                libraryId: docLibraryId,
                documentId,
                chunkIndex: 0,
                locator: "p.1",
                page: 1,
                text: "部署前先完成检查。",
            },
            {
                userId,
                libraryId: docLibraryId,
                documentId,
                chunkIndex: 1,
                locator: "p.2",
                page: 2,
                text: "失败时执行回滚，并记录原因。",
            },
        ])
    })

    beforeEach(() => {
        vi.clearAllMocks()
        runtimeMocks.requireCurrentUser.mockResolvedValue({ id: userId })
    })

    it("系统计数问答真实执行 list_system_overview 并落 COMPLETED step", async () => {
        setMockModel([
            toolCallStream("tool-overview", "list_system_overview", {}),
            textStream("你有 1 个知识库。"),
        ])

        const response = await assistantChat(requestWith({
            messages: [{ id: "user-overview", role: "user", parts: [{ type: "text", text: "我有多少个知识库" }] }],
        }))
        expect(response.status).toBe(200)
        await expect(response.text()).resolves.toContain("你有 1 个知识库")

        const { steps } = await loadRunEvidence(response)
        expect(steps).toHaveLength(1)
        expect(steps[0]).toMatchObject({ toolName: "list_system_overview", status: "COMPLETED" })
        expect(steps[0]!.durationMs).toEqual(expect.any(Number))
        expect(steps[0]!.durationMs).toBeGreaterThanOrEqual(0)
        expect(JSON.parse(steps[0]!.outputJson!)).toMatchObject({ knowledgeBases: 1 })
    })

    it("focus knowledge 路由 knowledge+system，可检索、阅读并调用 show_citations", async () => {
        setMockModel([
            toolCallStream("tool-search", "search_knowledge", { query: "部署" }),
            toolCallStream("tool-read", "read_knowledge_node", { nodeKey: treeNodeKey }),
            toolCallStream("tool-citations", "show_citations", {
                id: "citations-deploy",
                citations: [{
                    id: `article-${articleId}`,
                    href: `/dashboard/knowledge/${knowledgeBaseId}/articles/${articleId}`,
                    title: "部署手册",
                    snippet: "先构建，再发布。失败时执行回滚。",
                    domain: "隔离知识库",
                    type: "article",
                }],
                variant: "default",
            }),
            textStream("部署流程与回滚方式已基于原文回答。"),
        ])

        const response = await assistantChat(requestWith({
            focus: { knowledgeBaseId: String(knowledgeBaseId), articleId: String(articleId) },
            messages: [{ id: "user-focus", role: "user", parts: [{ type: "text", text: "这里主要讲什么" }] }],
        }))
        expect(response.status).toBe(200)
        await response.text()

        const { run, steps } = await loadRunEvidence(response)

        expect(JSON.parse(run.intentDomainsJson!)).toEqual(["knowledge", "system"])
        expect(steps.map((step) => [step.toolName, step.status])).toEqual([
            ["search_knowledge", "COMPLETED"],
            ["read_knowledge_node", "COMPLETED"],
            ["show_citations", "COMPLETED"],
        ])
        // 检索管线已升级为 Tree+Vector+BM25 融合，mode 从 tree/tree+semantic 变为 hybrid，
        // 且每个命中会带上是被哪几路召回命中的（§28/§30）
        const searchOutput = JSON.parse(steps[0]!.outputJson!)
        expect(searchOutput).toMatchObject({
            mode: "hybrid",
            knowledgeBaseId: String(knowledgeBaseId),
        })
        expect(searchOutput.hits[0]).toMatchObject({ nodeKey: treeNodeKey })
        expect(Array.isArray(searchOutput.hits[0].recallSources)).toBe(true)
        expect(searchOutput.hits[0].recallSources.length).toBeGreaterThan(0)
        // search 只返回定位信息，不返回全文
        expect(searchOutput.hits[0]).not.toHaveProperty("contentMd")
        expect(JSON.parse(steps[2]!.outputJson!)).toMatchObject({ id: "citations-deploy" })
    })

    it("focus document 路由 doc_library+system，可检索、阅读并调用 show_citations", async () => {
        const href = `/dashboard/doc-library/${docLibraryId}?documentId=${documentId}`
        setMockModel([
            toolCallStream("tool-doc-focus-search", "search_documents", { query: "回滚" }),
            toolCallStream("tool-doc-focus-read", "read_document", { fromIndex: 1, limit: 1 }),
            toolCallStream("tool-doc-focus-citations", "show_citations", {
                id: "citations-doc-deploy",
                citations: [{
                    id: `document-${documentId}`,
                    href,
                    title: "部署与回滚文档",
                    snippet: "失败时执行回滚，并记录原因。",
                    domain: "发布文档库",
                    type: "document",
                }],
                variant: "default",
            }),
            textStream("文档说明失败时要执行回滚并记录原因。"),
        ])

        const response = await assistantChat(requestWith({
            focus: { libraryId: String(docLibraryId), documentId: String(documentId) },
            messages: [{ id: "user-doc-focus", role: "user", parts: [{ type: "text", text: "这里主要讲什么" }] }],
        }))
        expect(response.status).toBe(200)
        await response.text()

        const { run, steps } = await loadRunEvidence(response)

        expect(JSON.parse(run.intentDomainsJson!)).toEqual(["doc_library", "system"])
        expect(steps.map((step) => [step.toolName, step.status])).toEqual([
            ["search_documents", "COMPLETED"],
            ["read_document", "COMPLETED"],
            ["show_citations", "COMPLETED"],
        ])
        expect(JSON.parse(steps[2]!.outputJson!)).toMatchObject({
            id: "citations-doc-deploy",
            citations: [{ href }],
        })
    })

    it("无 focus 跨库检索返回知识库归属", async () => {
        setMockModel([
            toolCallStream("tool-cross-kb", "search_knowledge", { query: "部署" }),
            textStream("已找到隔离知识库中的部署内容。"),
        ])

        const response = await assistantChat(requestWith({
            messages: [{ id: "user-cross-kb", role: "user", parts: [{ type: "text", text: "知识库里的部署内容" }] }],
        }))
        expect(response.status).toBe(200)
        await response.text()

        const { steps } = await loadRunEvidence(response)
        const output = JSON.parse(steps[0]!.outputJson!)
        expect(output).toMatchObject({ mode: "cross_kb" })
        expect(output.hits[0]).toMatchObject({
            knowledgeBaseId: String(knowledgeBaseId),
            knowledgeBaseName: "隔离知识库",
        })
    })

    it("文档库检索命中定位，read_document 可从 fromIndex 续读", async () => {
        setMockModel([
            toolCallStream("tool-doc-search", "search_documents", { query: "回滚" }),
            toolCallStream("tool-doc-read", "read_document", { documentId, fromIndex: 1, limit: 1 }),
            textStream("回滚步骤位于 p.2。"),
        ])

        const response = await assistantChat(requestWith({
            messages: [{ id: "user-doc", role: "user", parts: [{ type: "text", text: "文档里的回滚流程" }] }],
        }))
        expect(response.status).toBe(200)
        await response.text()

        const { steps } = await loadRunEvidence(response)
        const searchOutput = JSON.parse(steps[0]!.outputJson!)
        const readOutput = JSON.parse(steps[1]!.outputJson!)
        expect(searchOutput[0]).toMatchObject({ documentId: String(documentId), locator: "p.2" })
        expect(readOutput).toMatchObject({ documentId: String(documentId), fromIndex: 1 })
        expect(readOutput.chunks[0]).toMatchObject({ chunkIndex: 1, locator: "p.2" })
    })

    it("两个列表工具只返回当前用户的库", async () => {
        setMockModel([
            toolCallStream("tool-list-kb", "list_knowledge_bases", {}),
            toolCallStream("tool-list-doc", "list_doc_libraries", {}),
            textStream("已列出当前用户的知识库和文档库。"),
        ])

        const response = await assistantChat(requestWith({
            messages: [{ id: "user-lists", role: "user", parts: [{ type: "text", text: "列出我的知识库和文档库" }] }],
        }))
        expect(response.status).toBe(200)
        await response.text()

        const { steps } = await loadRunEvidence(response)
        const knowledgeBases = JSON.parse(steps[0]!.outputJson!)
        const docLibraries = JSON.parse(steps[1]!.outputJson!)
        expect(knowledgeBases).toHaveLength(1)
        expect(knowledgeBases[0]).toMatchObject({ id: String(knowledgeBaseId), name: "隔离知识库" })
        expect(docLibraries).toHaveLength(1)
        expect(docLibraries[0]).toMatchObject({ id: String(docLibraryId), name: "发布文档库" })
    })

    it("save_answer_artifact 真实落行并关联 thread/run", async () => {
        setMockModel([
            toolCallStream("tool-artifact", "save_answer_artifact", {
                artifactType: "report",
                title: "系统概览报告",
                contentMd: "当前有 1 个知识库。",
                payload: { knowledgeBases: 1 },
            }),
            textStream("报告已保存。"),
        ])

        const response = await assistantChat(requestWith({
            messages: [{ id: "user-artifact", role: "user", parts: [{ type: "text", text: "把系统概览保存成报告" }] }],
        }))
        expect(response.status).toBe(200)
        await response.text()

        const threadId = Number(response.headers.get("X-Petrichor-Assistant-Thread-Id"))
        const { runId, steps } = await loadRunEvidence(response)
        const [artifact] = await getDb()
            .select()
            .from(schema.assistantArtifacts)
            .where(eq(schema.assistantArtifacts.runId, runId))
        expect(steps[0]).toMatchObject({ toolName: "save_answer_artifact", status: "COMPLETED" })
        expect(artifact).toMatchObject({
            threadId,
            runId,
            kind: "report",
            title: "系统概览报告",
        })
        expect(JSON.parse(artifact!.contentJson!)).toEqual({
            contentMd: "当前有 1 个知识库。",
            payload: { knowledgeBases: 1 },
        })
    })

    it("不存在的 documentId 记录 FAILED step，但 SSE 继续且 run 完成", async () => {
        setMockModel([
            toolCallStream("tool-missing-doc", "read_document", { documentId: 999999 }),
            textStream("指定文档不存在，我无法读取。"),
        ])

        const response = await assistantChat(requestWith({
            messages: [{ id: "user-missing-doc", role: "user", parts: [{ type: "text", text: "读取文档内容" }] }],
        }))
        expect(response.status).toBe(200)
        await expect(response.text()).resolves.toContain("指定文档不存在")

        const threadId = Number(response.headers.get("X-Petrichor-Assistant-Thread-Id"))
        const { run, steps } = await loadRunEvidence(response)
        const messages = await getDb()
            .select()
            .from(schema.assistantMessages)
            .where(eq(schema.assistantMessages.threadId, threadId))
            .orderBy(asc(schema.assistantMessages.id))
        expect(run).toMatchObject({ status: "COMPLETED", errorCode: null })
        expect(steps).toHaveLength(1)
        expect(steps[0]).toMatchObject({ toolName: "read_document", status: "FAILED" })
        const failedOutput = JSON.parse(steps[0]!.outputJson!)
        expect(failedOutput.ok === false || typeof failedOutput.error === "string").toBe(true)
        expect(messages).toHaveLength(2)
        expect(messages[1]!.role).toBe("assistant")
        expect(messages[1]!.contentJson).toContain("指定文档不存在")
    })
})
