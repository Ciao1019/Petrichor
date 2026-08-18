import { MockLanguageModelV3, simulateReadableStream } from "ai/test"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { PetrichorAgentRuntime } from "./runtime"
import { AgentSkillRegistry } from "./skill-registry"
import { AgentToolRegistry } from "./tool-registry"
import type { AgentStreamEvent } from "./events"
import type { AgentToolDefinition } from "./types"

/**
 * 线上实测暴露出来的回归用例。
 * 每条都对应一次真实的错误输出，不是假想场景。
 */

type Turn =
    | { kind: "text"; text: string }
    | { kind: "tool"; toolName: string; args: Record<string, unknown> }
    /** 先说一段话再调工具——正是"过程话被当成答案"的成因 */
    | { kind: "textThenTool"; text: string; toolName: string; args: Record<string, unknown> }

function scriptedModel(turns: Turn[]) {
    let index = 0
    return new MockLanguageModelV3({
        doStream: async () => {
            const turn = turns[Math.min(index, turns.length - 1)]
            index += 1
            const id = `c${index}`
            const textChunks = (text: string) => [
                { type: "text-start", id },
                { type: "text-delta", id, delta: text },
                { type: "text-end", id },
            ]
            const toolChunk = (name: string, args: Record<string, unknown>) => ({
                type: "tool-call",
                toolCallId: `call_${index}`,
                toolName: name,
                input: JSON.stringify(args),
            })

            const chunks = turn.kind === "text"
                ? textChunks(turn.text)
                : turn.kind === "tool"
                    ? [toolChunk(turn.toolName, turn.args)]
                    : [...textChunks(turn.text), toolChunk(turn.toolName, turn.args)]

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
        description: id,
        inputSchema: z.object({}).passthrough(),
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
    return { conversationId: "c1", userId: 2, goal, model, modelName: "mock", isOperator: false, ...extra }
}

/** 只产候选、不产证据的检索工具——真实 knowledge.search 的行为 */
const searchTool = (hits: number) => tool(
    "knowledge.search",
    "search_knowledge",
    "knowledge",
    async () => ({ hits: Array.from({ length: hits }, (_v, i) => ({ nodeKey: `a1-${i}` })) }),
    {
        core: true,
        normalize: (output) => {
            const list = (output as { hits: unknown[] }).hits
            return list.length === 0
                ? { summary: "未检索到相关内容" }
                : { summary: `找到 ${list.length} 个相关知识节点`, progress: true, data: { hits: list } }
        },
    },
)

describe("过程话不得成为最终答案", () => {
    it("模型先说「我来读取正文」再调工具时，这句不进答案", async () => {
        tools.register(searchTool(3))
        tools.register(tool("knowledge.read", "read_knowledge_node", "knowledge", async () => ({ contentMd: "小鼹鼠是一部动画" }), {
            core: true,
            normalize: (output) => ({
                summary: "已读取文档",
                evidence: [{
                    source: "knowledge",
                    title: "小鼹鼠",
                    content: (output as { contentMd: string }).contentMd,
                    metadata: { nodeKey: "a1-0" },
                }],
            }),
        }))

        const events: AgentStreamEvent[] = []
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run({
            ...request(
                scriptedModel([
                    { kind: "textThenTool", text: "知识库中有相关条目，我来读取正文确认细节。", toolName: "search_knowledge", args: { query: "小鼹鼠" } },
                    { kind: "textThenTool", text: "先看看这一篇。", toolName: "read_knowledge_node", args: { nodeKey: "a1-0" } },
                    { kind: "text", text: "小鼹鼠是一部动画作品 [1]。" },
                ]),
                "小鼹鼠是什么",
            ),
            onEvent: (event) => events.push(event),
        })

        expect(result.answer).toBe("小鼹鼠是一部动画作品 [1]。")
        expect(result.answer).not.toContain("我来读取正文")
        expect(result.answer).not.toContain("先看看这一篇")
        // 每次判定为过程话都会重发 started，让前端清掉已渲染的半截文本
        expect(events.filter((event) => event.type === "final_answer_started").length).toBeGreaterThanOrEqual(2)
    })

    it("只有过程话、没有后续答案时不会把过程话当结论交付", async () => {
        tools.register(searchTool(3))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "textThenTool", text: "知识库中有相关条目，我来读取正文确认细节。", toolName: "search_knowledge", args: { query: "小鼹鼠" } },
                { kind: "text", text: "" },
            ]),
            "小鼹鼠是什么",
        ))
        expect(result.answer).not.toContain("我来读取正文确认细节")
    })
})

describe("证据充足时不得草率作答", () => {
    it("读到长正文却只答一句时，自动进入最终回答阶段重写", async () => {
        tools.register(searchTool(2))
        tools.register(tool("knowledge.read", "read_knowledge_node", "knowledge", async () => ({
            contentMd: "小鼹鼠的定位、核心能力、使用方式、适用对象、限制与注意事项。".repeat(60),
        }), {
            core: true,
            normalize: (output) => ({
                summary: "已读取小鼹鼠完整介绍",
                evidence: [{
                    source: "knowledge",
                    title: "小鼹鼠完整介绍",
                    content: (output as { contentMd: string }).contentMd,
                    metadata: { nodeKey: "a1-0" },
                }],
            }),
        }))

        const events: AgentStreamEvent[] = []
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run({
            ...request(
                scriptedModel([
                    { kind: "tool", toolName: "search_knowledge", args: { query: "小鼹鼠" } },
                    { kind: "tool", toolName: "read_knowledge_node", args: { nodeKey: "a1-0" } },
                    { kind: "text", text: "小鼹鼠是一款 macOS 清理工具 [1]。" },
                    {
                        kind: "text",
                        text: [
                            "小鼹鼠是一款面向 macOS 的开源命令行维护工具 [1]。",
                            "它集中提供垃圾清理、应用卸载残留处理、磁盘分析和系统检查等能力 [1]。",
                            "它更适合愿意使用终端并希望统一执行维护操作的用户 [1]。",
                            "使用前应核对待删除内容和权限，重要数据需要先备份 [1]。",
                        ].join("\n\n"),
                    },
                ]),
                "小鼹鼠是什么",
            ),
            onEvent: (event) => events.push(event),
        })

        expect(result.answer).toContain("它集中提供垃圾清理")
        expect(result.answer).not.toBe("小鼹鼠是一款 macOS 清理工具 [1]。")
        expect(events.filter((event) => event.type === "final_answer_started")).toHaveLength(2)
        expect(result.trace.steps).toContainEqual(expect.objectContaining({
            type: "answer_quality_checked",
            payload: expect.objectContaining({ adequate: false, depth: "standard" }),
        }))
    })
})

describe("检索产候选算进展", () => {
    it("连续多次检索不会被误判为 no_progress", async () => {
        tools.register(searchTool(3))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "search_knowledge", args: { query: "小鼹鼠" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "鼹鼠 动画" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "鼹鼠 角色" } },
                { kind: "text", text: "根据检索结果作答。" },
            ]),
            "小鼹鼠是什么",
        ))

        expect(result.state.stopReason).not.toBe("no_progress")
        expect(result.answer).toBe("根据检索结果作答。")
    })

    it("检索确实一无所获时仍会触发 no_progress", async () => {
        tools.register(searchTool(0))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([
                { kind: "tool", toolName: "search_knowledge", args: { query: "A" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "B" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "C" } },
                { kind: "tool", toolName: "search_knowledge", args: { query: "D" } },
            ]),
            "为什么这个东西会这样，现有设计在哪里做了处理？",
        ))
        expect(["no_progress", "loop_detected", "max_tool_calls"]).toContain(result.state.stopReason)
    })
})

describe("低置信度 Router 提示不干扰执行", () => {
    const noSignalHint = { domains: ["system", "knowledge", "doc_library"], confidence: 0.3, reasoning: "no-signal:default-read-domains" }

    it("不预热能力，也不产生「启用所需能力」步骤", async () => {
        tools.register(searchTool(1))
        tools.register(tool("system.overview", "list_system_overview", "system", async () => ({}), { core: true }))
        skills.registerMany([
            { id: "knowledge", name: "知识库", description: "检索", instructions: "K", toolIds: ["knowledge.search"] },
            { id: "system", name: "系统", description: "概览", instructions: "S", toolIds: ["system.overview"] },
        ])

        const events: AgentStreamEvent[] = []
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run({
            ...request(scriptedModel([{ kind: "text", text: "答案。" }]), "小鼹鼠是什么", { routingHint: noSignalHint }),
            onEvent: (event) => events.push(event),
        })

        expect(events.some((event) => event.type === "skill_loaded")).toBe(false)
        expect(result.state.loadedSkills).toHaveLength(0)
    })

    it("不因兜底的多域提示把简单问题判成跨域复杂任务", async () => {
        tools.register(searchTool(1))
        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([{ kind: "text", text: "答案。" }]),
            "小鼹鼠是什么",
            { routingHint: noSignalHint },
        ))
        expect(result.state.complexity).toBe("simple")
    })

    it("高置信度提示仍会预热能力", async () => {
        tools.register(searchTool(1))
        skills.register({ id: "knowledge", name: "知识库", description: "检索", instructions: "K", toolIds: ["knowledge.search"] })

        const runtime = new PetrichorAgentRuntime({ tools, skills })
        const result = await runtime.run(request(
            scriptedModel([{ kind: "text", text: "答案。" }]),
            "查一下知识库里的部署说明",
            { routingHint: { domains: ["knowledge"], confidence: 0.9, reasoning: "keyword" } },
        ))
        expect(result.state.loadedSkills).toContain("knowledge")
    })
})
