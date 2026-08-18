import { describe, expect, it } from "vitest"
import { BudgetTracker } from "./budget"
import { resolveBudget } from "./config"

describe("BudgetTracker", () => {
    it("按复杂度取不同预算，direct 不给工具调用", () => {
        expect(resolveBudget("direct").maxToolCalls).toBe(0)
        expect(resolveBudget("simple").maxToolCalls).toBeLessThan(resolveBudget("complex").maxToolCalls)
        expect(resolveBudget("complex").maxSubAgents).toBeGreaterThan(0)
        expect(resolveBudget("simple").maxSubAgents).toBe(0)
    })

    it("剩余时间随时钟推进而减少", () => {
        const now = 1_000_000
        const tracker = new BudgetTracker("simple", { now })
        expect(tracker.remainingMs(now)).toBe(tracker.budget.maxExecutionMs)
        expect(tracker.remainingMs(now + 1_000)).toBe(tracker.budget.maxExecutionMs - 1_000)
        expect(tracker.timeExhausted(now + tracker.budget.maxExecutionMs)).toBe(true)
    })

    it("子代理配额可计数并判满", () => {
        const tracker = new BudgetTracker("complex", { now: 0 })
        expect(tracker.subAgentsExhausted()).toBe(false)
        for (let i = 0; i < tracker.budget.maxSubAgents; i += 1) tracker.countSubAgent()
        expect(tracker.subAgentsExhausted()).toBe(true)
    })

    it("工具自己声明的更短超时必须被尊重", () => {
        const now = 1_000_000
        const tracker = new BudgetTracker("complex", { now })
        expect(tracker.clampToolTimeout(30, now)).toBe(30)
    })

    it("剩余时间不足时把超时压到剩余时间", () => {
        const now = 1_000_000
        const tracker = new BudgetTracker("simple", { now })
        const nearEnd = now + tracker.budget.maxExecutionMs - 2_000
        expect(tracker.clampToolTimeout(45_000, nearEnd)).toBe(2_000)
    })

    it("压缩后不低于 1s，避免刚起步就必然超时", () => {
        const now = 1_000_000
        const tracker = new BudgetTracker("simple", { now })
        const almostOver = now + tracker.budget.maxExecutionMs - 10
        expect(tracker.clampToolTimeout(45_000, almostOver)).toBe(1_000)
    })

    it("时间已耗尽时不再压缩，交给 StopPolicy 裁决", () => {
        const now = 1_000_000
        const tracker = new BudgetTracker("simple", { now })
        const over = now + tracker.budget.maxExecutionMs + 1_000
        expect(tracker.clampToolTimeout(45_000, over)).toBe(45_000)
    })
})
