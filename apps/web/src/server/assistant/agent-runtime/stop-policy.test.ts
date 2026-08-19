import { describe, expect, it } from "vitest"
import { BudgetTracker } from "./budget"
import { LoopDetector } from "./loop-detector"
import { AgentStateStore } from "./state"
import { describeStopReasonForUser, StopPolicy } from "./stop-policy"
import type { StopPolicyConfig } from "./types"

function setup(overrides: Partial<StopPolicyConfig> = {}) {
    const config: StopPolicyConfig = {
        maxIterations: 5,
        maxToolCalls: 4,
        maxExecutionMs: 10_000,
        maxSubAgents: 2,
        maxDelegationDepth: 2,
        maxNoProgressIterations: 3,
        ...overrides,
    }
    const budget = new BudgetTracker("multi_step", { budget: config })
    const loopDetector = new LoopDetector({ noProgressThreshold: 99 })
    const policy = new StopPolicy(config, budget, loopDetector)
    const state = new AgentStateStore({ conversationId: "c1", userId: "1", goal: "g" })
    return { config, budget, loopDetector, policy, state }
}

describe("StopPolicy", () => {
    it("迭代次数超限触发 max_iterations", () => {
        const { policy, state } = setup({ maxIterations: 2 })
        state.incrementIteration()
        state.incrementIteration()
        expect(policy.evaluateBeforeIteration(state.current)).toMatchObject({ stop: true, reason: "max_iterations" })
    })

    it("工具调用超限触发 max_tool_calls", () => {
        const { policy, state } = setup({ maxToolCalls: 2 })
        state.incrementToolCall()
        state.incrementToolCall()
        expect(policy.evaluateAfterToolCall(state.current)).toMatchObject({ stop: true, reason: "max_tool_calls" })
    })

    it("工具预算用尽但已有证据时正常收敛作答", () => {
        const { policy, state } = setup({ maxToolCalls: 2 })
        state.addEvidence([{
            id: "e1",
            source: "knowledge",
            content: "可用于作答的正文",
            createdAt: Date.now(),
        }])
        state.incrementToolCall()
        state.incrementToolCall()

        expect(policy.evaluateAfterToolCall(state.current)).toMatchObject({
            stop: true,
            reason: "enough_evidence",
        })
    })

    it("超时触发 max_execution_time", () => {
        const { policy, state } = setup({ maxExecutionMs: 1_000 })
        const later = Date.now() + 2_000
        expect(policy.evaluateBeforeIteration(state.current, later)).toMatchObject({
            stop: true,
            reason: "max_execution_time",
        })
    })

    it("token 超限触发 max_tokens", () => {
        const { policy, state } = setup({ maxTokens: 100 })
        state.addTokenUsage({ input: 60, output: 60 })
        expect(policy.evaluateBeforeIteration(state.current)).toMatchObject({ stop: true, reason: "max_tokens" })
    })

    it("检测到循环触发 loop_detected", () => {
        const { policy, state, loopDetector } = setup()
        const call = { toolId: "knowledge.search", input: { query: "x" }, producedEvidence: true }
        loopDetector.record(call)
        loopDetector.record(call)
        loopDetector.record(call)
        expect(policy.evaluateAfterToolCall(state.current)).toMatchObject({ stop: true, reason: "loop_detected" })
    })

    it("连续无进展触发 no_progress", () => {
        const config: StopPolicyConfig = {
            maxIterations: 10,
            maxToolCalls: 10,
            maxExecutionMs: 10_000,
            maxSubAgents: 2,
            maxDelegationDepth: 2,
            maxNoProgressIterations: 2,
        }
        const loopDetector = new LoopDetector({ noProgressThreshold: 99 })
        const policy = new StopPolicy(config, new BudgetTracker("simple", { budget: config }), loopDetector)
        const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "g" })
        loopDetector.record({ toolId: "a.x", input: { q: 1 }, producedEvidence: false })
        loopDetector.record({ toolId: "b.y", input: { q: 2 }, producedEvidence: false })
        expect(policy.evaluateAfterToolCall(state.current)).toMatchObject({ stop: true, reason: "no_progress" })
    })

    it("委派深度到顶时拒绝再委派", () => {
        const { policy } = setup({ maxDelegationDepth: 1 })
        expect(policy.evaluateBeforeDelegation(0).stop).toBe(false)
        expect(policy.evaluateBeforeDelegation(1)).toMatchObject({ stop: true, reason: "max_delegation_depth" })
    })

    it("子代理配额用尽时拒绝委派", () => {
        const { policy, budget } = setup({ maxSubAgents: 1 })
        budget.countSubAgent()
        expect(policy.evaluateBeforeDelegation(0).stop).toBe(true)
    })

    it("预算充足时不停止", () => {
        const { policy, state } = setup()
        expect(policy.evaluateBeforeIteration(state.current).stop).toBe(false)
        expect(policy.evaluateAfterToolCall(state.current).stop).toBe(false)
        expect(policy.remainingToolCalls(state.current)).toBe(4)
    })
})

describe("describeStopReasonForUser", () => {
    it("正常完成不产生提示", () => {
        expect(describeStopReasonForUser("goal_completed")).toBeNull()
        expect(describeStopReasonForUser(undefined)).toBeNull()
    })

    it("内部策略名不暴露给用户", () => {
        const text = describeStopReasonForUser("loop_detected")!
        expect(text).not.toContain("loop")
        expect(text).toContain("停止")
    })
})
