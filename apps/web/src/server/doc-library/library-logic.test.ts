import { beforeEach, describe, expect, it, vi } from "vitest"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

const configMocks = vi.hoisted(() => ({
    getServerConfig: vi.fn(),
}))

const s3Mocks = vi.hoisted(() => ({
    deleteS3Objects: vi.fn(),
}))

vi.mock("@/server/db/client", () => dbMocks)
vi.mock("@/config/server", () => configMocks)
vi.mock("@/server/upload/s3-delete", () => s3Mocks)

import { deleteDocument, deleteLibrary } from "./library-logic"

type QueryChain = {
    from: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
    orderBy: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    where: ReturnType<typeof vi.fn>
    then: Promise<unknown>["then"]
}

function createQueryChain(result: unknown): QueryChain {
    const chain = {} as QueryChain
    chain.from = vi.fn(() => chain)
    chain.limit = vi.fn(async () => result)
    chain.orderBy = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected)
    return chain
}

function createDbMock(selectResults: unknown[]) {
    let selectIndex = 0
    const updateChains: QueryChain[] = []
    const tx = {
        delete: vi.fn(() => createQueryChain([])),
        update: vi.fn(() => {
            const chain = createQueryChain([])
            updateChains.push(chain)
            return chain
        }),
    }
    const db = {
        select: vi.fn(() => createQueryChain(selectResults[selectIndex++] ?? [])),
        transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    }
    return { db, tx, updateChains }
}

function createS3Config() {
    return {
        accessKeyId: "test-ak",
        bucket: "bucket",
        downloadExpireSeconds: 3600,
        endpoint: "https://s3.example.com",
        region: "cn-east-1",
        secretAccessKey: "test-sk",
        uploadExpireSeconds: 900,
    }
}

function sqlText(value: unknown) {
    const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? []
    return chunks
        .map((chunk) => {
            const maybeValue = (chunk as { value?: unknown }).value
            return Array.isArray(maybeValue) ? maybeValue.join("") : ""
        })
        .join("")
}

describe("doc library deletion", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        configMocks.getServerConfig.mockReturnValue({ s3: createS3Config() })
        s3Mocks.deleteS3Objects.mockResolvedValue({
            deletedObjectKeys: ["uploads/2/report.pdf"],
            failedObjectKeys: [],
        })
    })

    it("删除文档时清理语料、文档记录、计数和远程对象", async () => {
        const { db, tx, updateChains } = createDbMock([
            [{
                id: 7,
                libraryId: 1,
                objectKey: "uploads/2/report.pdf",
                userId: 2,
            }],
        ])
        dbMocks.getDb.mockReturnValue(db)

        const result = await deleteDocument(2, 7)

        expect(tx.delete).toHaveBeenCalledTimes(2)
        expect(tx.update).toHaveBeenCalledTimes(1)
        const updateSet = updateChains[0]!.set.mock.calls[0]![0] as Record<string, unknown>
        const decrementSql = sqlText(updateSet.documentCount)
        expect(decrementSql).toContain("case when ")
        expect(decrementSql).not.toContain("max(")
        expect(s3Mocks.deleteS3Objects).toHaveBeenCalledWith(
            expect.objectContaining({ bucket: "bucket" }),
            ["uploads/2/report.pdf"],
        )
        expect(result.storageCleanup.failedObjectKeys).toEqual([])
    })

    it("删除文档库时清理库内全部文档远程对象", async () => {
        const { db, tx } = createDbMock([
            [{ id: 1, userId: 2 }],
            [
                { objectKey: "uploads/2/a.pdf" },
                { objectKey: "s4key:uploads/2/b.docx" },
                { objectKey: "uploads/3/other.pdf" },
            ],
        ])
        dbMocks.getDb.mockReturnValue(db)
        s3Mocks.deleteS3Objects.mockResolvedValue({
            deletedObjectKeys: ["uploads/2/a.pdf", "uploads/2/b.docx"],
            failedObjectKeys: [],
        })

        const result = await deleteLibrary(2, 1)

        expect(tx.delete).toHaveBeenCalledTimes(4)
        expect(s3Mocks.deleteS3Objects).toHaveBeenCalledWith(
            expect.objectContaining({ bucket: "bucket" }),
            ["uploads/2/a.pdf", "uploads/2/b.docx"],
        )
        expect(result.storageCleanup.failedObjectKeys).toEqual([
            {
                errorMessage: "文档对象键不属于当前用户，已跳过远程删除",
                objectKey: "uploads/3/other.pdf",
            },
        ])
    })
})
