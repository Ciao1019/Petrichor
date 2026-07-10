import { describe, expect, it, vi } from "vitest"
import {
    TOOL_TIMEOUT_MS,
    createToolResilienceController,
    decideToolFailure,
    isPlaybookToolResult,
} from "./tool-resilience"

describe("decideToolFailure", () => {
    it("耗尽或 streak 达阈值 → circuit_open", () => {
        expect(decideToolFailure({
            toolName: "search_knowledge",
            errorCode: "tool_retry_exhausted",
            failStreak: 2,
        }).action).toBe("circuit_open")
        expect(decideToolFailure({
            toolName: "search_knowledge",
            errorCode: "tool_error",
            failStreak: 2,
        }).action).toBe("circuit_open")
    })

    it("超时 → retry_other_tool", () => {
        const decision = decideToolFailure({
            toolName: "slow",
            errorCode: "tool_timeout",
            failStreak: 1,
        })
        expect(decision.action).toBe("retry_other_tool")
        expect(decision.messageForModel).toContain("超时")
    })

    it("接近耗尽的普通错误 → answer_without_tool", () => {
        expect(decideToolFailure({
            toolName: "flaky",
            errorCode: "tool_error",
            failStreak: 1,
            exhaustThreshold: 2,
        }).action).toBe("answer_without_tool")
    })
})

describe("createToolResilienceController playbook", () => {
    it("成功执行后清零 streak，meta 无 errorCode", async () => {
        const resilience = createToolResilienceController({ timeoutMs: 100 })
        const value = await resilience.run("search_knowledge", async () => "ok")
        expect(value).toBe("ok")
        expect(resilience.consumeMeta("search_knowledge")).toMatchObject({
            errorCode: null,
        })
    })

    it("超时 soft return tool_degraded 并累计 streak", async () => {
        const resilience = createToolResilienceController({ timeoutMs: 20 })
        const result = await resilience.run("slow_tool", async () => {
            await new Promise((resolve) => setTimeout(resolve, 80))
            return "late"
        })
        expect(isPlaybookToolResult(result)).toBe(true)
        expect(result).toMatchObject({
            ok: false,
            errorCode: "tool_degraded",
            action: "retry_other_tool",
        })
        expect(resilience.consumeMeta("slow_tool")?.errorCode).toBe("tool_degraded")
    })

    it("同名连续失败达到阈值后熔断且不执行真实逻辑", async () => {
        const resilience = createToolResilienceController({
            timeoutMs: 50,
            exhaustThreshold: 2,
        })
        const execute = vi.fn(async () => {
            throw new Error("boom")
        })

        const first = await resilience.run("flaky", execute)
        expect(first).toMatchObject({ ok: false, errorCode: "tool_degraded" })
        const second = await resilience.run("flaky", execute)
        expect(second).toMatchObject({ ok: false, errorCode: "tool_circuit_open", action: "circuit_open" })
        expect(execute).toHaveBeenCalledTimes(2)

        const third = await resilience.run("flaky", execute)
        expect(third).toMatchObject({ ok: false, errorCode: "tool_circuit_open" })
        expect(execute).toHaveBeenCalledTimes(2)
        expect(resilience.consumeMeta("flaky")?.errorCode).toBe("tool_circuit_open")
    })

    it("中间成功会清零 streak，允许再次失败", async () => {
        const resilience = createToolResilienceController({ exhaustThreshold: 2 })
        let round = 0
        const execute = vi.fn(async () => {
            round += 1
            if (round === 1 || round === 3) throw new Error("boom")
            return "ok"
        })

        await expect(resilience.run("recover", execute)).resolves.toMatchObject({
            ok: false,
            errorCode: "tool_degraded",
        })
        await expect(resilience.run("recover", execute)).resolves.toBe("ok")
        await expect(resilience.run("recover", execute)).resolves.toMatchObject({
            ok: false,
            errorCode: "tool_degraded",
        })
        expect(execute).toHaveBeenCalledTimes(3)
    })

    it("默认超时为 30 秒常量", () => {
        expect(TOOL_TIMEOUT_MS).toBe(30_000)
    })
})
