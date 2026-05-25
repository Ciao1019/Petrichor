import type { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const authMocks = vi.hoisted(() => ({
    requireCurrentUser: vi.fn(),
}))

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

const configMocks = vi.hoisted(() => ({
    getServerConfig: vi.fn(),
}))

const cacheMocks = vi.hoisted(() => ({
    invalidatePublicArticleDetailCache: vi.fn(),
    invalidatePublicArticleListCache: vi.fn(),
}))

const s3Mocks = vi.hoisted(() => ({
    deleteS3Objects: vi.fn(),
}))

const nextServerMocks = vi.hoisted(() => ({
    after: vi.fn(),
}))

vi.mock("@/server/auth/current-user", () => authMocks)
vi.mock("@/server/db/client", () => dbMocks)
vi.mock("@/config/server", () => configMocks)
vi.mock("@/server/public-content-cache", () => cacheMocks)
vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>()
    return {
        ...actual,
        after: nextServerMocks.after,
    }
})
vi.mock("@/server/upload/s3-delete", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/server/upload/s3-delete")>()
    return {
        ...actual,
        deleteS3Objects: s3Mocks.deleteS3Objects,
    }
})

import { deleteArticle, updateArticle } from "@/server/kb/handlers"

type QueryChain = {
    from: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
    orderBy: ReturnType<typeof vi.fn>
    returning: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    values: ReturnType<typeof vi.fn>
    where: ReturnType<typeof vi.fn>
    then: Promise<unknown>["then"]
}

function createQueryChain(result: unknown): QueryChain {
    const chain = {} as QueryChain
    chain.from = vi.fn(() => chain)
    chain.limit = vi.fn(async () => result)
    chain.orderBy = vi.fn(() => chain)
    chain.returning = vi.fn(async () => result)
    chain.set = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected)
    return chain
}

function createDbMock({
    deleteResults = [],
    selectResults = [],
    updateResults = [],
}: {
    deleteResults?: unknown[]
    selectResults?: unknown[]
    updateResults?: unknown[]
}) {
    let deleteIndex = 0
    let selectIndex = 0
    let updateIndex = 0

    return {
        delete: vi.fn(() => createQueryChain(deleteResults[deleteIndex++] ?? [])),
        insert: vi.fn(() => createQueryChain([])),
        select: vi.fn(() => createQueryChain(selectResults[selectIndex++] ?? [])),
        update: vi.fn(() => createQueryChain(updateResults[updateIndex++] ?? [])),
    }
}

function createJsonRequest(body: unknown) {
    return {
        json: vi.fn(async () => body),
        nextUrl: { pathname: "/test" },
    } as unknown as NextRequest
}

type ScheduledTask = () => unknown | Promise<unknown>

async function runScheduledAfterTasks(tasks: ScheduledTask[]) {
    for (const task of tasks.splice(0)) {
        await task()
    }
}

function createArticleRecord(overrides: Record<string, unknown> = {}) {
    return {
        contentJson: null,
        contentMd: "",
        id: 9,
        knowledgeBaseId: 3,
        nodeId: 5,
        title: "旧标题",
        userId: 1,
        ...overrides,
    }
}

describe("article S4 image cleanup handlers", () => {
    let scheduledTasks: ScheduledTask[]

    beforeEach(() => {
        vi.clearAllMocks()
        scheduledTasks = []
        nextServerMocks.after.mockImplementation((task: ScheduledTask) => {
            scheduledTasks.push(task)
        })
        authMocks.requireCurrentUser.mockResolvedValue({ id: 1 })
        configMocks.getServerConfig.mockReturnValue({
            s3: {
                accessKeyId: "test-ak",
                bucket: "bucket",
                downloadExpireSeconds: 3600,
                endpoint: "https://s3.example.com",
                region: "cn-east-1",
                secretAccessKey: "test-sk",
                uploadExpireSeconds: 900,
            },
        })
        s3Mocks.deleteS3Objects.mockResolvedValue({
            deletedObjectKeys: ["uploads/1/old.png"],
            failedObjectKeys: [],
        })
    })

    it("保存文章后清理已从正文移除且无人引用的图片对象", async () => {
        const db = createDbMock({
            selectResults: [
                [createArticleRecord({ contentMd: "![旧图](s4key:uploads/1/old.png)" })],
                [],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        await updateArticle(createJsonRequest({
            articleId: "9",
            contentJson: null,
            contentMd: "# 新正文",
            contentMetaJson: null,
            tags: [],
            title: "新标题",
        }))

        expect(nextServerMocks.after).toHaveBeenCalledTimes(1)
        expect(s3Mocks.deleteS3Objects).not.toHaveBeenCalled()
        await runScheduledAfterTasks(scheduledTasks)
        expect(s3Mocks.deleteS3Objects).toHaveBeenCalledWith(
            expect.objectContaining({ bucket: "bucket" }),
            ["uploads/1/old.png"],
        )
    })

    it("保存文章时保留仍被其它文章引用的图片对象", async () => {
        const db = createDbMock({
            selectResults: [
                [createArticleRecord({ contentMd: "![旧图](s4key:uploads/1/old.png)" })],
                [{ contentJson: null, contentMd: "![复用](s4key:uploads/1/old.png)" }],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        await updateArticle(createJsonRequest({
            articleId: "9",
            contentJson: null,
            contentMd: "# 新正文",
            contentMetaJson: null,
            tags: [],
            title: "新标题",
        }))

        expect(nextServerMocks.after).toHaveBeenCalledTimes(1)
        await runScheduledAfterTasks(scheduledTasks)
        expect(s3Mocks.deleteS3Objects).not.toHaveBeenCalled()
    })

    it("删除文章后清理文章独占的图片对象", async () => {
        const db = createDbMock({
            selectResults: [
                [createArticleRecord({ contentMd: "![旧图](s4key:uploads/1/old.png)" })],
                [],
            ],
        })
        dbMocks.getDb.mockReturnValue(db)

        await deleteArticle(createJsonRequest({ articleId: "9" }))

        expect(nextServerMocks.after).toHaveBeenCalledTimes(1)
        expect(s3Mocks.deleteS3Objects).not.toHaveBeenCalled()
        await runScheduledAfterTasks(scheduledTasks)
        expect(s3Mocks.deleteS3Objects).toHaveBeenCalledWith(
            expect.objectContaining({ bucket: "bucket" }),
            ["uploads/1/old.png"],
        )
    })
})
