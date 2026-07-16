import { beforeEach, describe, expect, it, vi } from "vitest"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

vi.mock("@/server/db/client", () => dbMocks)

import {
    consumeAssistantConfirmation,
    issueAssistantConfirmation,
} from "./confirmation-store"

beforeEach(() => {
    dbMocks.getDb.mockReset()
})

describe("confirmation-store", () => {
    it("issue 写入 pending 票据", async () => {
        const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined)
        const values = vi.fn(() => ({ onConflictDoUpdate }))
        const insert = vi.fn(() => ({ values }))
        dbMocks.getDb.mockReturnValue({ insert })

        await issueAssistantConfirmation({
            confirmationKey: "c1",
            userId: 1,
            threadId: 2,
            toolName: "delete_article",
            actionInput: { articleId: "9" },
        })

        expect(insert).toHaveBeenCalled()
        expect(values).toHaveBeenCalled()
        expect(onConflictDoUpdate).toHaveBeenCalled()
    })

    it("consume 原子更新并返回服务端 action", async () => {
        const returning = vi.fn().mockResolvedValue([{
            toolName: "delete_article",
            inputJson: JSON.stringify({ articleId: "9" }),
        }])
        const where = vi.fn(() => ({ returning }))
        const set = vi.fn(() => ({ where }))
        const update = vi.fn(() => ({ set }))
        dbMocks.getDb.mockReturnValue({ update })

        const action = await consumeAssistantConfirmation({
            confirmationKey: "c1",
            userId: 1,
            threadId: 2,
        })
        expect(action).toEqual({
            toolName: "delete_article",
            input: { articleId: "9" },
        })
    })

    it("consume 无 pending 行时抛错", async () => {
        const returning = vi.fn().mockResolvedValue([])
        const where = vi.fn(() => ({ returning }))
        const set = vi.fn(() => ({ where }))
        const update = vi.fn(() => ({ set }))
        dbMocks.getDb.mockReturnValue({ update })

        await expect(consumeAssistantConfirmation({
            confirmationKey: "missing",
            userId: 1,
            threadId: 2,
        })).rejects.toThrow(/确认已失效/)
    })
})
