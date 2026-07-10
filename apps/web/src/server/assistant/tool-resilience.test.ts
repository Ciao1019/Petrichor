import { describe, expect, it, vi } from "vitest"
import {
    TOOL_TIMEOUT_MS,
    ToolResilienceError,
    createToolResilienceController,
} from "./tool-resilience"

describe("createToolResilienceController", () => {
    it("成功执行后清零 streak，meta 无 errorCode", async () => {
        const resilience = createToolResilienceController({ timeoutMs: 100 })
        const value = await resilience.run("search_knowledge", async () => "ok")
        expect(value).toBe("ok")
        expect(resilience.consumeMeta("search_knowledge")).toMatchObject({
            errorCode: null,
        })
    })

    it("超时抛出 tool_timeout 并累计 streak", async () => {
        const resilience = createToolResilienceController({ timeoutMs: 20 })
        await expect(resilience.run("slow_tool", async () => {
            await new Promise((resolve) => setTimeout(resolve, 80))
            return "late"
        })).rejects.toMatchObject({ code: "tool_timeout" })
        expect(resilience.consumeMeta("slow_tool")?.errorCode).toBe("tool_timeout")
    })

    it("同名连续失败达到阈值后短路且不执行真实逻辑", async () => {
        const resilience = createToolResilienceController({
            timeoutMs: 50,
            exhaustThreshold: 2,
        })
        const execute = vi.fn(async () => {
            throw new Error("boom")
        })

        await expect(resilience.run("flaky", execute)).rejects.toBeInstanceOf(ToolResilienceError)
        await expect(resilience.run("flaky", execute)).rejects.toBeInstanceOf(ToolResilienceError)
        expect(execute).toHaveBeenCalledTimes(2)

        await expect(resilience.run("flaky", execute)).rejects.toMatchObject({
            code: "tool_retry_exhausted",
        })
        expect(execute).toHaveBeenCalledTimes(2)
        expect(resilience.consumeMeta("flaky")?.errorCode).toBe("tool_retry_exhausted")
    })

    it("中间成功会清零 streak，允许再次失败", async () => {
        const resilience = createToolResilienceController({ exhaustThreshold: 2 })
        let round = 0
        const execute = vi.fn(async () => {
            round += 1
            if (round === 1 || round === 3) throw new Error("boom")
            return "ok"
        })

        await expect(resilience.run("recover", execute)).rejects.toMatchObject({ code: "tool_error" })
        await expect(resilience.run("recover", execute)).resolves.toBe("ok")
        await expect(resilience.run("recover", execute)).rejects.toMatchObject({ code: "tool_error" })
        expect(execute).toHaveBeenCalledTimes(3)
    })

    it("默认超时为 30 秒常量", () => {
        expect(TOOL_TIMEOUT_MS).toBe(30_000)
    })
})
