import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AssistantToolContext } from "../domain-types"

const libraryMocks = vi.hoisted(() => ({
    listLibraries: vi.fn(),
    readDocumentChunks: vi.fn(),
    searchChunks: vi.fn(),
}))

vi.mock("@/server/doc-library/library-logic", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/server/doc-library/library-logic")>()
    return { ...actual, ...libraryMocks }
})

import { docLibraryAssistantTools, readDocument, searchDocuments } from "./doc-library"

const baseCtx: AssistantToolContext = {
    userId: 7,
    threadId: 11,
    runId: 13,
    focus: null,
}

function findTool(name: string) {
    const registration = docLibraryAssistantTools.find((tool) => tool.name === name)
    if (!registration) throw new Error(`未找到工具：${name}`)
    return registration
}

describe("doc library assistant tools", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        libraryMocks.listLibraries.mockResolvedValue([])
        libraryMocks.searchChunks.mockResolvedValue([])
        libraryMocks.readDocumentChunks.mockResolvedValue({})
    })

    it("list_doc_libraries 只把当前 userId 交给既有归属查询", async () => {
        libraryMocks.listLibraries.mockResolvedValue([{ id: "2", name: "合同库" }])

        await expect(findTool("list_doc_libraries").execute(baseCtx, {})).resolves.toEqual([
            { id: "2", name: "合同库" },
        ])
        expect(libraryMocks.listLibraries).toHaveBeenCalledWith(7)
    })

    it("未显式限定时使用 focus.libraryId/documentId", async () => {
        const ctx = { ...baseCtx, focus: { libraryId: "2", documentId: "5" } }

        await searchDocuments(ctx, { query: "违约责任", limit: 6 })

        expect(libraryMocks.searchChunks).toHaveBeenCalledWith({
            userId: 7,
            libraryId: 2,
            documentId: 5,
            query: "违约责任",
            limit: 6,
        })
    })

    it("显式范围优先，不让 focus.documentId 意外限制另一个文档库", async () => {
        const ctx = { ...baseCtx, focus: { libraryId: "2", documentId: "5" } }

        await searchDocuments(ctx, { query: "发布", libraryId: 9 })

        expect(libraryMocks.searchChunks).toHaveBeenCalledWith({
            userId: 7,
            libraryId: 9,
            documentId: null,
            query: "发布",
            limit: undefined,
        })
    })

    it("read_document 使用 focus.documentId 并原样转发 fromIndex/limit", async () => {
        const ctx = { ...baseCtx, focus: { documentId: "5" } }
        libraryMocks.readDocumentChunks.mockResolvedValue({
            documentId: "5",
            fromIndex: 12,
            chunks: [{ chunkIndex: 12, text: "下一页" }],
        })

        await expect(readDocument(ctx, { fromIndex: 12, limit: 4 })).resolves.toMatchObject({
            documentId: "5",
            fromIndex: 12,
        })
        expect(libraryMocks.readDocumentChunks).toHaveBeenCalledWith({
            userId: 7,
            documentId: 5,
            fromIndex: 12,
            limit: 4,
        })
    })

    it("read_document 无显式 id 且无 focus 时拒绝调用", async () => {
        await expect(readDocument(baseCtx, {})).rejects.toMatchObject({ status: 400 })
        expect(libraryMocks.readDocumentChunks).not.toHaveBeenCalled()
    })

    it("三个工具的 name/domain/risk 与契约一致", () => {
        expect(docLibraryAssistantTools.map(({ name, domain, risk }) => ({ name, domain, risk }))).toEqual([
            { name: "list_doc_libraries", domain: "doc_library", risk: "read" },
            { name: "search_documents", domain: "doc_library", risk: "read" },
            { name: "read_document", domain: "doc_library", risk: "read" },
        ])
    })
})
