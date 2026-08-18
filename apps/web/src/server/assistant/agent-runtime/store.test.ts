import { describe, expect, it, vi } from "vitest"

const getDb = vi.fn()
vi.mock("@/server/db/client", () => ({ getDb: () => getDb() }))

import { __testing, listAgentRunsForConversation, loadAgentRunTrace, loadAgentRunView } from "./store"

/**
 * 持久化层的错误日志必须能定位问题：
 * drizzle 只给 "Failed query"，真正原因在 error.cause 上。
 */
describe("logStoreError", () => {
    function capture(error: unknown): Record<string, unknown> {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        __testing.logStoreError("createRun", error, { runKey: "run_x" })
        const payload = JSON.parse(String(spy.mock.calls[0][0]))
        spy.mockRestore()
        return payload
    }

    it("把 cause 上的 Postgres 错误码与详情带出来", () => {
        const error = new Error("Failed query: insert into ...")
        error.cause = { code: "42P01", message: 'relation "petrichor_agent_run" does not exist' }
        const payload = capture(error)

        expect(payload.code).toBe("42P01")
        expect(payload.cause).toContain("does not exist")
    })

    it("表不存在时给出可执行的迁移提示", () => {
        const error = new Error("Failed query")
        error.cause = { code: "42P01", message: "relation does not exist" }
        expect(String(capture(error).hint)).toContain("2026-08-18-agent-runtime-v2.sql")
    })

    it("其它错误码不会误报迁移提示", () => {
        const error = new Error("Failed query")
        error.cause = { code: "23505", message: "duplicate key" }
        const payload = capture(error)
        expect(payload.hint).toBeUndefined()
        expect(payload.code).toBe("23505")
    })

    it("没有 cause 时不崩，仍保留上下文", () => {
        const payload = capture(new Error("boom"))
        expect(payload.message).toBe("boom")
        expect(payload.runKey).toBe("run_x")
    })

    it("非 Error 值也能记录", () => {
        expect(capture("plain string").message).toBe("plain string")
    })
})

/**
 * 读路径必须 fail-open：迁移未执行时接口不能 500，
 * 否则聊天页恢复执行面板时会整页报错。
 */
describe("读路径容错", () => {
    function throwUndefinedTable() {
        getDb.mockImplementation(() => {
            const error = new Error("Failed query: select ...")
            error.cause = { code: "42P01", message: 'relation "petrichor_agent_run" does not exist' }
            throw error
        })
    }

    it("表不存在时 loadAgentRunView 返回 null 而不是抛错", async () => {
        throwUndefinedTable()
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        await expect(loadAgentRunView("run_x", 1)).resolves.toBeNull()
        expect(String(spy.mock.calls[0][0])).toContain("2026-08-18-agent-runtime-v2.sql")
        spy.mockRestore()
    })

    it("表不存在时 loadAgentRunTrace 返回 null", async () => {
        throwUndefinedTable()
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        await expect(loadAgentRunTrace("run_x", 1)).resolves.toBeNull()
        spy.mockRestore()
    })

    it("表不存在时 listAgentRunsForConversation 返回空数组", async () => {
        throwUndefinedTable()
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        await expect(listAgentRunsForConversation("1", 1)).resolves.toEqual([])
        spy.mockRestore()
    })
})
