import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { AgentError } from "./errors"
import { EvidenceStore } from "./evidence"
import { AgentEventEmitter, type AgentStreamEvent } from "./events"
import { LoopDetector } from "./loop-detector"
import { toModelResult } from "./mastra-bridge"
import { ObservationStore } from "./observation"
import { DefaultPermissionResolver } from "./permissions"
import { AgentStateStore } from "./state"
import { ToolExecutor } from "./tool-executor"
import { AgentToolRegistry } from "./tool-registry"
import { TraceCollector } from "./trace"
import type { AgentToolDefinition, ToolExecutionContext } from "./types"

function harness(tools: AgentToolDefinition[], options?: { events?: (event: AgentStreamEvent) => void }) {
    const registry = new AgentToolRegistry()
    registry.registerMany(tools)
    const state = new AgentStateStore({ conversationId: "c1", userId: "1", goal: "g" })
    const observations = new ObservationStore()
    const evidence = new EvidenceStore()
    const trace = new TraceCollector("run1", "c1", "1", "test-model")
    const loopDetector = new LoopDetector()
    const executor = new ToolExecutor({
        registry,
        permissions: new DefaultPermissionResolver((id) => registry.get(id)),
        observations,
        evidence,
        state,
        trace,
        loopDetector,
        ...(options?.events ? { events: new AgentEventEmitter("run1", options.events) } : {}),
    })
    const ctx: ToolExecutionContext = {
        runId: "run1",
        userId: 1,
        conversationId: "c1",
        delegationDepth: 0,
        state: state.current,
    }
    return { registry, state, observations, evidence, trace, executor, ctx }
}

const okTool: AgentToolDefinition = {
    id: "knowledge.search",
    name: "search_knowledge",
    namespace: "knowledge",
    description: "搜索",
    inputSchema: z.object({ query: z.string().min(1) }),
    riskLevel: "low",
    sideEffect: false,
    execute: async (_ctx, input) => ({ hits: [{ nodeKey: "a1-0", title: String((input as { query: string }).query) }] }),
    normalize: (output) => {
        const hits = (output as { hits: unknown[] }).hits
        return {
            summary: `找到 ${hits.length} 个节点`,
            data: { hits },
            evidence: [{ source: "knowledge", content: "正文片段", metadata: { nodeKey: "a1-0" } }],
        }
    },
}

describe("ToolExecutor 正常路径", () => {
    it("执行成功后写入观察、证据、状态与 trace", async () => {
        const { executor, ctx, state, observations, evidence, trace } = harness([okTool])
        const outcome = await executor.execute("knowledge.search", { query: "redis" }, ctx)

        expect(outcome.ok).toBe(true)
        expect(outcome.observation.summary).toBe("找到 1 个节点")
        expect(evidence.size).toBe(1)
        expect(observations.size).toBe(1)
        expect(state.current.toolCallCount).toBe(1)
        expect(trace.build().toolCalls[0]).toMatchObject({ toolId: "knowledge.search", ok: true })
    })

    it("原始结果只进 trace，不进观察", async () => {
        const { executor, ctx, trace } = harness([okTool])
        const outcome = await executor.execute("knowledge.search", { query: "redis" }, ctx)
        expect(outcome.observation.data).toEqual({ hits: [{ nodeKey: "a1-0", title: "redis" }] })
        expect(trace.build().toolCalls[0].rawOutput).toBeDefined()
    })

    it("把知识召回与重排诊断写入 trace 延迟指标", async () => {
        const { executor, ctx, trace } = harness([{
            ...okTool,
            execute: async () => ({
                hits: [{ nodeKey: "a1-0", title: "redis" }],
                diagnostics: {
                    query: "redis",
                    treeKeys: [],
                    vectorKeys: ["a1-0"],
                    bm25Keys: ["a1-0"],
                    fusionKeys: ["a1-0"],
                    finalKeys: ["a1-0"],
                    rerankApplied: true,
                    retrievalMs: 37,
                    rerankMs: 11,
                },
            }),
        }])

        await executor.execute("knowledge.search", { query: "redis" }, ctx)
        const built = trace.build()

        expect(built.steps).toContainEqual(expect.objectContaining({
            type: "retrieval_diagnostics",
            payload: expect.objectContaining({
                query: "redis",
                vectorKeys: ["a1-0"],
                bm25Keys: ["a1-0"],
                finalKeys: ["a1-0"],
            }),
        }))
        expect(built.latency).toMatchObject({ retrievalMs: 37, rerankMs: 11 })
    })

    it("发出 tool_started / tool_completed / evidence_created 事件", async () => {
        const events: AgentStreamEvent[] = []
        const { executor, ctx } = harness([okTool], { events: (event) => events.push(event) })
        await executor.execute("knowledge.search", { query: "redis" }, ctx)
        expect(events.map((event) => event.type)).toEqual([
            "tool_started",
            "tool_completed",
            "observation_created",
            "evidence_created",
        ])
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    })

    it("段内模型能看到 Evidence 正文，重复证据沿用同一引用编号", async () => {
        const { executor, ctx } = harness([okTool])
        const first = await executor.execute("knowledge.search", { query: "redis" }, ctx)
        const second = await executor.execute("knowledge.search", { query: "redis-2" }, ctx)
        const modelResult = toModelResult(second) as {
            evidence?: Array<{ ref: number; content?: string }>
        }

        expect(first.evidenceCitationIndices).toEqual([1])
        expect(second.evidenceCitationIndices).toEqual([1])
        expect(modelResult.evidence?.[0]).toMatchObject({ ref: 1, content: "正文片段" })
    })
})

describe("ToolExecutor 校验与权限", () => {
    it("参数非法时不执行工具，返回可修正的错误观察", async () => {
        const execute = vi.fn()
        const { executor, ctx } = harness([{ ...okTool, execute }])
        const outcome = await executor.execute("knowledge.search", { query: "" }, ctx)

        expect(execute).not.toHaveBeenCalled()
        expect(outcome.ok).toBe(false)
        expect(outcome.error?.code).toBe("TOOL_VALIDATION_ERROR")
        expect(outcome.observation.suggestedActions).toContain("fix_arguments")
    })

    it("未注册工具直接失败", async () => {
        const { executor, ctx } = harness([okTool])
        const outcome = await executor.execute("nope.x", {}, ctx)
        expect(outcome.ok).toBe(false)
        expect(outcome.error?.code).toBe("TOOL_VALIDATION_ERROR")
    })

    it("权限不足时不执行、不重试，并记录 permission_denied", async () => {
        const execute = vi.fn()
        const { executor, ctx, trace } = harness([{
            ...okTool,
            id: "admin.reset",
            name: "reset",
            namespace: "admin",
            requiresOperator: true,
            execute,
        }])
        // userId=1 在本站默认视为超级管理员，权限用例必须用普通用户
        const outcome = await executor.execute("admin.reset", { query: "x" }, { ...ctx, userId: 2 })

        expect(execute).not.toHaveBeenCalled()
        expect(outcome.error?.code).toBe("TOOL_PERMISSION_DENIED")
        expect(outcome.retries).toBe(0)
        expect(trace.build().toolCalls[0].permissionDecision).toBe("denied")
    })

    it("子代理不能使用授权范围外的工具", async () => {
        const registry = new AgentToolRegistry()
        registry.register(okTool)
        const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "g" })
        const executor = new ToolExecutor({
            registry,
            permissions: new DefaultPermissionResolver((id) => registry.get(id)),
            observations: new ObservationStore(),
            evidence: new EvidenceStore(),
            state,
            trace: new TraceCollector("r", "c", "1", "m"),
            loopDetector: new LoopDetector(),
            allowedToolIds: ["document.read"],
        })
        const outcome = await executor.execute("knowledge.search", { query: "x" }, {
            runId: "r",
            userId: 1,
            conversationId: "c",
            delegationDepth: 1,
            state: state.current,
        })
        expect(outcome.error?.code).toBe("TOOL_PERMISSION_DENIED")
    })

    it("需要确认的副作用工具在未确认时不执行", async () => {
        const execute = vi.fn()
        const registry = new AgentToolRegistry()
        registry.register({
            ...okTool,
            id: "document.share",
            name: "share",
            namespace: "document",
            sideEffect: true,
            requiresConfirmation: true,
            execute,
        })
        const state = new AgentStateStore({ conversationId: "c", userId: "1", goal: "g" })
        const executor = new ToolExecutor({
            registry,
            permissions: new DefaultPermissionResolver((id) => registry.get(id)),
            observations: new ObservationStore(),
            evidence: new EvidenceStore(),
            state,
            trace: new TraceCollector("r", "c", "1", "m"),
            loopDetector: new LoopDetector(),
            confirmSideEffect: async () => false,
        })
        const outcome = await executor.execute("document.share", { query: "x" }, {
            runId: "r",
            userId: 1,
            conversationId: "c",
            delegationDepth: 0,
            state: state.current,
        })
        expect(execute).not.toHaveBeenCalled()
        expect(outcome.error?.code).toBe("TOOL_PERMISSION_DENIED")
    })
})

describe("ToolExecutor 重试与超时", () => {
    it("可重试错误按 maxRetries 重试一次", async () => {
        let calls = 0
        const { executor, ctx } = harness([{
            ...okTool,
            maxRetries: 1,
            execute: async () => {
                calls += 1
                if (calls === 1) throw new AgentError("TOOL_TIMEOUT", "超时", { retryable: true })
                return { hits: [] }
            },
        }])
        const outcome = await executor.execute("knowledge.search", { query: "x" }, ctx)
        expect(calls).toBe(2)
        expect(outcome.ok).toBe(true)
        expect(outcome.retries).toBe(1)
    })

    it("不可重试错误只执行一次", async () => {
        let calls = 0
        const { executor, ctx } = harness([{
            ...okTool,
            execute: async () => {
                calls += 1
                throw new AgentError("TOOL_PERMISSION_DENIED", "无权限", { retryable: false })
            },
        }])
        const outcome = await executor.execute("knowledge.search", { query: "x" }, ctx)
        expect(calls).toBe(1)
        expect(outcome.error?.code).toBe("TOOL_PERMISSION_DENIED")
    })

    it("超时被规范成 TOOL_TIMEOUT 并转成带建议的错误观察", async () => {
        const { executor, ctx } = harness([{
            ...okTool,
            timeoutMs: 20,
            maxRetries: 0,
            execute: async () => await new Promise((resolve) => setTimeout(resolve, 200)),
        }])
        const outcome = await executor.execute("knowledge.search", { query: "x" }, ctx)
        expect(outcome.error?.code).toBe("TOOL_TIMEOUT")
        expect(outcome.observation.isError).toBe(true)
        expect(outcome.observation.suggestedActions).toContain("use_alternative_source")
    })

    it("失败也计入工具预算，避免绕过 maxToolCalls", async () => {
        const { executor, ctx, state } = harness([{
            ...okTool,
            maxRetries: 0,
            execute: async () => {
                throw new AgentError("TOOL_EXECUTION_ERROR", "boom", { retryable: false })
            },
        }])
        await executor.execute("knowledge.search", { query: "x" }, ctx)
        expect(state.current.toolCallCount).toBe(1)
    })
})
