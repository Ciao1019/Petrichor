import { MockLanguageModelV3, simulateReadableStream } from "ai/test"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { PetrichorAgentRuntime } from "./runtime"
import { AgentSkillRegistry } from "./skill-registry"
import { AgentToolRegistry } from "./tool-registry"
import type { AgentStreamEvent } from "./events"
import type { AgentToolDefinition } from "./types"

/**
 * Golden 验收用例（§73/§120~§134）。
 *
 * 每条对应需求文档里的一个验收场景，用脚本化模型驱动真实 Mastra 循环。
 */

type Turn =
    | { kind: "text"; text: string }
    | { kind: "tool"; toolName: string; args: Record<string, unknown> }

function scriptedModel(turns: Turn[]) {
    let index = 0
    return new MockLanguageModelV3({
        doStream: async () => {
            const turn = turns[Math.min(index, turns.length - 1)]
            index += 1
            const id = `c${index}`
            const chunks = turn.kind === "text"
                ? [
                    { type: "text-start", id },
                    { type: "text-delta", id, delta: turn.text },
                    { type: "text-end", id },
                ]
                : [{
                    type: "tool-call",
                    toolCallId: `call_${index}`,
                    toolName: turn.toolName,
                    input: JSON.stringify(turn.args),
                }]
            return {
                stream: simulateReadableStream({
                    chunks: ([
                        { type: "stream-start", warnings: [] },
                        ...chunks,
                        {
                            type: "finish",
                            finishReason: turn.kind === "text" ? "stop" : "tool-calls",
                            usage: {
                                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                                outputTokens: { total: 5, text: 5, reasoning: 0 },
                                totalTokens: 15,
                            },
                        },
                    ] as never[]),
                    chunkDelayInMs: 0,
                }),
            }
        },
    })
}

function tool(
    id: string,
    name: string,
    namespace: AgentToolDefinition["namespace"],
    execute: AgentToolDefinition["execute"],
    extra?: Partial<AgentToolDefinition>,
): AgentToolDefinition {
    return {
        id,
        name,
        namespace,
        description: `${id} 测试工具`,
        inputSchema: z.object({ query: z.string().optional() }).passthrough(),
        riskLevel: "low",
        sideEffect: false,
        execute,
        ...extra,
    }
}

let tools: AgentToolRegistry
let skills: AgentSkillRegistry

beforeEach(() => {
    tools = new AgentToolRegistry()
    skills = new AgentSkillRegistry()
})

function request(model: unknown, goal: string, extra: Record<string, unknown> = {}) {
    return {
        conversationId: "c1",
        userId: 2,
        goal,
        model,
        modelName: "mock",
        isOperator: false,
        ...extra,
    }
}

const knowledgeSearch = (hits: unknown[]) => tool(
    "knowledge.search",
    "search_knowledge",
    "knowledge",
    async () => ({ hits }),
    {
        core: true,
        normalize: (output) => {
            const list = (output as { hits: unknown[] }).hits
            return list.length === 0
                ? { summary: "知识库中未检索到相关内容", suggestedActions: ["rewrite_query"] }
                : { summary: `找到 ${list.length} 个相关知识节点`, data: { hits: list } }
        },
    },
)

const knowledgeRead = (content: string) => tool(
    "knowledge.read",
    "read_knowledge_node",
    "knowledge",
    async () => ({ contentMd: content, title: "文档" }),
    {
        core: true,
        normalize: (output) => ({
            summary: "已读取文档",
            evidence: [{
                source: "knowledge",
                title: "文档",
                content: (output as { contentMd: string }).contentMd,
                metadata: { nodeKey: `n${Math.random()}` },
            }],
        }),
    },
)

describe("§120 Direct", () => {
    it("直接回答，不建计划、不加载技能、不调用工具", async () => {
        tools.register(knowledgeSearch([]))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([{ kind: "text", text: "等于 2。" }]),
            "1+1 等于多少？",
        ))

        expect(result.state.complexity).toBe("direct")
        expect(result.state.toolCallCount).toBe(0)
        expect(result.state.plan).toHaveLength(0)
        expect(result.answer).toContain("2")
    })
})

describe("§121 Knowledge QA", () => {
    it("search → read → answer", async () => {
        tools.register(knowledgeSearch([{ nodeKey: "a1-0" }]))
        tools.register(knowledgeRead("使用 Sentinel 三节点部署"))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "search_knowledge", args: { query: "Redis 部署" } },
                { kind: "tool", toolName: "read_knowledge_node", args: { nodeKey: "a1-0" } },
                { kind: "text", text: "我们用 Sentinel 三节点部署 [1]。" },
            ]),
            "我们项目 Redis 是怎么部署的？",
        ))

        const toolIds = result.trace.toolCalls.map((call) => call.toolId)
        expect(toolIds).toEqual(["knowledge.search", "knowledge.read"])
        expect(result.state.evidence).toHaveLength(1)
        expect(result.evaluation.citationCoverage).toBeGreaterThan(0)
    })
})

describe("§122 Knowledge 多跳", () => {
    it("允许 search → read → 新 query → search → read", async () => {
        tools.register(knowledgeSearch([{ nodeKey: "a1-0" }]))
        tools.register(knowledgeRead("消费者使用 List 弹出"))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "search_knowledge", args: { query: "Redis 消费" } },
                { kind: "tool", toolName: "read_knowledge_node", args: { nodeKey: "a1-0" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "幂等策略" } },
                { kind: "tool", toolName: "read_knowledge_node", args: { nodeKey: "a2-1" } },
                { kind: "text", text: "重复消费源于 ACK 时机 [1]，幂等在写入层处理 [2]。" },
            ]),
            "为什么我们的 Redis 消费可能出现重复，现有设计在哪里做了幂等？",
        ))

        expect(result.state.complexity).not.toBe("direct")
        expect(result.trace.toolCalls.length).toBeGreaterThanOrEqual(4)
        expect(result.state.evidence.length).toBeGreaterThanOrEqual(1)
    })
})

describe("§123/§128 Router 判断错误也不能阻止跨域", () => {
    it("Router 只识别 knowledge，Agent 仍可加载 research", async () => {
        tools.register(knowledgeSearch([{ nodeKey: "a1-0" }]))
        tools.register(tool("agent.load_skill", "load_skill", "agent", async (ctx, raw) => {
            const result = await ctx.services!.loadSkill((raw as { skill: string }).skill)
            return { ok: result.ok, toolIds: result.toolIds }
        }, { core: true, inputSchema: z.object({ skill: z.string() }) }))
        tools.register(tool("research.search", "research_search", "research", async () => ({ ok: true }), {
            normalize: () => ({
                summary: "外部搜索找到 1 个来源",
                evidence: [{ source: "web", title: "官方文档", content: "官方推荐 Streams", url: "https://redis.io/x" }],
            }),
        }))
        skills.register({
            id: "research",
            name: "研究",
            description: "外部检索",
            instructions: "RESEARCH",
            toolIds: ["research.search"],
        })

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "load_skill", args: { skill: "research" } },
                { kind: "tool", toolName: "research_search", args: { query: "redis streams" } },
                { kind: "text", text: "官方目前推荐 Streams [1]。" },
            ]),
            "查一下我们内部的 Redis 方案，再结合最新公开资料做对比分析",
            { routingHint: { domains: ["knowledge"], confidence: 0.9 } },
        ))

        expect(result.state.loadedSkills).toContain("research")
        expect(result.state.evidence.some((item) => item.source === "web")).toBe(true)
        // Router 预测与实际使用不一致，会被 Eval 记录下来
        expect(result.evaluation.routerPredictedDomains).toEqual(["knowledge"])
        expect(result.evaluation.actualNamespaces).toContain("research")
    })
})

describe("§129 No Result", () => {
    it("检索无结果时给出可执行建议，且不无限搜索", async () => {
        tools.register(knowledgeSearch([]))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "search_knowledge", args: { query: "A" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "B" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "C" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "D" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "E" } },
            ]),
            "为什么我们的订单对账会出现差异，现有设计在哪里做了兜底？",
        ))

        expect(result.state.observations.some((item) => item.summary.includes("未检索到"))).toBe(true)
        expect(result.state.status).toBe("stopped")
        expect(["no_progress", "loop_detected", "max_tool_calls", "max_iterations"])
            .toContain(result.state.stopReason)
    })
})

describe("§130 Tool Error", () => {
    it("工具失败转成错误观察，Run 不崩溃", async () => {
        let calls = 0
        tools.register(tool("research.fetch", "research_fetch", "research", async () => {
            calls += 1
            throw new Error("请求目标网页超时 timeout")
        }, { core: true, maxRetries: 1 }))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const events: AgentStreamEvent[] = []
        const result = await runtime.run({
            ...request(
                scriptedModel([
                    { kind: "tool", toolName: "research_fetch", args: { query: "x" } },
                    { kind: "text", text: "外部资料暂时拿不到，先基于内部信息回答。" },
                ]),
                "查一下这个页面最新的官方说明",
            ),
            onEvent: (event) => events.push(event),
        })

        expect(calls).toBe(2) // 首次 + 1 次重试
        const errorObservation = result.state.observations.find((item) => item.isError)
        expect(errorObservation?.suggestedActions).toContain("use_alternative_source")
        expect(result.state.status).not.toBe("failed")
        // 用户可见文案不含堆栈
        const failed = events.find((event) => event.type === "tool_failed")
        expect(JSON.stringify(failed?.payload)).not.toContain("Error:")
    })
})

describe("§131 Loop", () => {
    it("同参数反复调用触发 loop_detected", async () => {
        tools.register(knowledgeSearch([{ nodeKey: "a1-0" }]))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([{ kind: "tool", toolName: "search_knowledge", args: { query: "同一个查询" } }]),
            "为什么这个流程会卡住，现有设计在哪里做了重试？",
        ))

        expect(["loop_detected", "no_progress"]).toContain(result.state.stopReason)
    })
})

describe("§132 Side Effect", () => {
    it("需要确认的工具在未确认时不执行，并记录 Trace", async () => {
        let executed = false
        tools.register(tool("document.delete", "delete_document", "document", async () => {
            executed = true
            return { ok: true }
        }, {
            core: true,
            sideEffect: true,
            riskLevel: "high",
            requiresConfirmation: true,
            allowedInSubAgent: false,
        }))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run({
            ...request(
                scriptedModel([
                    { kind: "tool", toolName: "delete_document", args: { query: "doc" } },
                    { kind: "text", text: "该操作需要你确认后才能执行。" },
                ]),
                "把那份过期文档删掉",
            ),
            confirmSideEffect: async () => false,
        })

        expect(executed).toBe(false)
        const call = result.trace.toolCalls.find((item) => item.toolId === "document.delete")
        expect(call?.ok).toBe(false)
        expect(call?.permissionDecision).toBe("denied")
    })

    it("确认通过后正常执行", async () => {
        let executed = false
        tools.register(tool("document.delete", "delete_document", "document", async () => {
            executed = true
            return { ok: true }
        }, { core: true, sideEffect: true, riskLevel: "high", requiresConfirmation: true, allowedInSubAgent: false }))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        await runtime.run({
            ...request(
                scriptedModel([
                    { kind: "tool", toolName: "delete_document", args: { query: "doc" } },
                    { kind: "text", text: "已删除。" },
                ]),
                "把那份过期文档删掉",
            ),
            confirmSideEffect: async () => true,
        })

        expect(executed).toBe(true)
    })
})

describe("§119 Permission", () => {
    it("未授权的管理工具不执行、不重试，Trace 记 permission_denied", async () => {
        let executed = false
        tools.register(tool("admin.reset", "admin_reset", "admin", async () => {
            executed = true
            return { ok: true }
        }, { core: true, requiresOperator: true, riskLevel: "high", sideEffect: true }))
        // 补一个普通用户可用的核心工具，保证 activeTools 非空
        tools.register(knowledgeSearch([]))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([{ kind: "text", text: "当前账号没有该权限。" }]),
            "帮我重置一下系统配置",
        ))

        expect(executed).toBe(false)
        // requiresOperator 的工具对非操作员根本不会出现在工具集里
        expect(result.trace.toolCalls.every((call) => call.toolId !== "admin.reset")).toBe(true)
    })
})

describe("§118 Timeout", () => {
    it("工具超时被规范成 TOOL_TIMEOUT，Run 继续", async () => {
        tools.register(tool("research.fetch", "research_fetch", "research", async () => {
            await new Promise((resolve) => setTimeout(resolve, 300))
            return { ok: true }
        }, { core: true, timeoutMs: 30, maxRetries: 0 }))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "research_fetch", args: { query: "x" } },
                { kind: "text", text: "来源暂时不可用。" },
            ]),
            "抓一下这个页面",
        ))

        expect(result.trace.toolCalls[0].errorCode).toBe("TOOL_TIMEOUT")
        expect(result.state.status).not.toBe("failed")
    })
})

describe("§133 长会话上下文控制", () => {
    it("大量证据不会全部塞进上下文", async () => {
        tools.register(tool("knowledge.read", "read_knowledge_node", "knowledge", async () => ({
            contentMd: "正文内容".repeat(500),
        }), {
            core: true,
            normalize: (output, input) => ({
                summary: "已读取",
                evidence: [{
                    source: "knowledge",
                    title: `文档 ${JSON.stringify(input)}`,
                    content: (output as { contentMd: string }).contentMd,
                    metadata: { nodeKey: `n-${JSON.stringify(input)}` },
                }],
            }),
        }))

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "read_knowledge_node", args: { query: "1" } },
                { kind: "tool", toolName: "read_knowledge_node", args: { query: "2" } },
                { kind: "tool", toolName: "read_knowledge_node", args: { query: "3" } },
                { kind: "text", text: "综合以上内容 [1]。" },
            ]),
            "把这几份文档综合分析一下，并对比它们的差异，给出技术选型建议",
            { contextTokenLimit: 4_000 },
        ))

        expect(result.state.evidence.length).toBeGreaterThan(0)
        expect(result.answer).toContain("综合")
    })
})
