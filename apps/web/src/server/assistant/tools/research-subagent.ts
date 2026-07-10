import { desc, eq } from "drizzle-orm"
import { Agent } from "@mastra/core/agent"
import { z } from "zod"
import { createChatLanguageModel } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { assistantRuns, assistantSteps } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"
import type { AgentDomainId, AssistantFocus, AssistantToolContext, AssistantToolRegistration } from "../domain-types"
import { loadMastraToolsForDomains } from "../tool-registry"
import { createToolResilienceController, ToolResilienceError } from "../tool-resilience"
import { assistantFocusSchema, recordAssistantStep } from "../thread-logic"

export const SUBAGENT_MAX_STEPS = 6
export const SUBAGENT_TIMEOUT_MS = 90_000
export const SPAWN_RESEARCH_SUBAGENT = "spawn_research_subagent"

const READ_ONLY_DOMAINS = new Set<AgentDomainId>(["knowledge", "doc_library", "system"])

/** 子代理禁止再委派、写产物、改计划、确认卡 */
const BLOCKED_SUBAGENT_TOOLS = new Set([
    SPAWN_RESEARCH_SUBAGENT,
    "save_answer_artifact",
    "upsert_plan",
    "request_user_confirmation",
    "create_article",
    "update_article",
    "create_article_share",
    "set_default_ai_config",
    "list_ai_configs",
    "list_agent_api_keys",
    "get_public_qa_setting",
])

const spawnSchema = z.object({
    goal: z.string().trim().min(1).max(2000),
    domains: z.array(z.enum(["knowledge", "doc_library", "system", "content_write", "admin"])).min(1).max(3),
    focus: assistantFocusSchema.optional().nullable(),
})

export const spawnResearchInputSchema = spawnSchema

export type SpawnResearchResult = {
    ok: boolean
    summary: string
    citations?: Array<{ title: string; href?: string; domain?: string; snippet?: string }>
    usage?: { calls: number; totalTokens: number }
    errorCode?: string | null
}

export function sanitizeResearchDomains(domains: string[]): AgentDomainId[] {
    const next = [...new Set(
        domains.filter((d): d is AgentDomainId => READ_ONLY_DOMAINS.has(d as AgentDomainId)),
    )]
    if (next.length === 0) return ["knowledge", "doc_library", "system"]
    return next
}

export function filterSubagentToolNames(toolNames: string[]): string[] {
    return toolNames.filter((name) => !BLOCKED_SUBAGENT_TOOLS.has(name))
}

function buildSubagentInstructions(goal: string): string {
    return [
        "你是 Petrichor 站内只读研究子代理。只通过工具检索与阅读，汇总给主助手。",
        "禁止声称已写入、删除或改配置；没有的工具不要假装调用。",
        "优先 search → read；最终用中文给出简洁结论，并尽量调用 show_citations（href 必须来自工具结果）。",
        `本轮目标：${goal}`,
    ].join("\n")
}

export async function spawnResearchSubagent(
    ctx: AssistantToolContext,
    raw: unknown,
): Promise<SpawnResearchResult> {
    const input = spawnSchema.parse(raw ?? {})
    if (input.domains.some((d) => d === "content_write" || d === "admin")) {
        throw badRequest("子代理 domains 仅允许 knowledge / doc_library / system")
    }
    const domains = sanitizeResearchDomains(input.domains)
    const focus = (input.focus ?? ctx.focus) as AssistantFocus | null

    const [run] = await getDb()
        .select({ modelConfigId: assistantRuns.modelConfigId })
        .from(assistantRuns)
        .where(eq(assistantRuns.id, ctx.runId))
        .limit(1)

    const resilience = createToolResilienceController()
    const subCtx: AssistantToolContext = {
        userId: ctx.userId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        focus,
    }
    const allTools = loadMastraToolsForDomains(domains, subCtx, resilience)
    const tools: typeof allTools = {}
    for (const name of filterSubagentToolNames(Object.keys(allTools))) {
        tools[name] = allTools[name]!
    }

    let stepIndex = await nextStepIndex(ctx.runId)
    let toolCalls = 0

    try {
        const { model } = await createChatLanguageModel({
            userId: ctx.userId,
            configId: run?.modelConfigId ?? null,
        })

        const agent = new Agent({
            id: "petrichor-research-subagent",
            name: "Petrichor Research Subagent",
            description: "Read-only research subagent for knowledge and document libraries.",
            model: model as never,
            instructions: buildSubagentInstructions(input.goal),
            tools,
        })

        const output = await Promise.race([
            agent.generate(input.goal, {
                maxSteps: SUBAGENT_MAX_STEPS,
                modelSettings: { temperature: 0.2 },
                activeTools: Object.keys(tools),
                hooks: {
                    afterToolCall: async ({
                        toolName,
                        output: toolOutput,
                        error,
                    }: {
                        toolName: string
                        output: unknown
                        error?: unknown
                    }) => {
                        toolCalls += 1
                        const meta = resilience.consumeMeta(toolName)
                        const isSuccess = error == null && meta?.errorCode == null
                        const errorCode = isSuccess
                            ? null
                            : meta?.errorCode
                                ?? (error instanceof ToolResilienceError ? error.code : "tool_error")
                        await recordAssistantStep({
                            runId: ctx.runId,
                            stepIndex: stepIndex++,
                            toolName: `${SPAWN_RESEARCH_SUBAGENT}/${toolName}`,
                            input: {},
                            output: isSuccess
                                ? toolOutput
                                : {
                                    error: error instanceof Error ? error.message : String(error ?? errorCode),
                                    errorCode,
                                },
                            status: isSuccess ? "COMPLETED" : "FAILED",
                            errorCode,
                            durationMs: meta?.durationMs ?? null,
                        })
                    },
                },
            } as never),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("subagent_timeout")), SUBAGENT_TIMEOUT_MS)
            }),
        ])

        const summary = typeof output.text === "string" ? output.text.trim() : ""
        const citations = extractCitations(output) ?? []
        const totalTokens = readTotalTokens(output)

        return {
            ok: Boolean(summary),
            summary: summary || "子代理未产出可读结论",
            ...(citations.length > 0 ? { citations } : {}),
            usage: { calls: toolCalls, totalTokens },
            errorCode: summary ? null : "empty_summary",
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const errorCode = message.includes("subagent_timeout") ? "tool_timeout" : "tool_error"
        return {
            ok: false,
            summary: `子代理失败：${message}`,
            usage: { calls: toolCalls, totalTokens: 0 },
            errorCode,
        }
    }
}

async function nextStepIndex(runId: number) {
    const [row] = await getDb()
        .select({ stepIndex: assistantSteps.stepIndex })
        .from(assistantSteps)
        .where(eq(assistantSteps.runId, runId))
        .orderBy(desc(assistantSteps.stepIndex))
        .limit(1)
    return (row?.stepIndex ?? -1) + 1
}

function readTotalTokens(output: { totalUsage?: unknown; usage?: unknown }): number {
    const total = asRecord(output.totalUsage)
    if (typeof total?.totalTokens === "number") return total.totalTokens
    if (typeof total?.total === "number") return total.total
    const usage = asRecord(output.usage)
    if (typeof usage?.totalTokens === "number") return usage.totalTokens
    return 0
}

function extractCitations(output: { toolResults?: unknown }): SpawnResearchResult["citations"] {
    const results = Array.isArray(output.toolResults) ? output.toolResults : []
    const citations: NonNullable<SpawnResearchResult["citations"]> = []
    for (const item of results) {
        const record = asRecord(item)
        const toolName = typeof record?.toolName === "string"
            ? record.toolName
            : typeof record?.name === "string"
                ? record.name
                : ""
        if (toolName !== "show_citations") continue
        const payload = asRecord(record?.result) ?? asRecord(record?.output) ?? record
        const list = Array.isArray(payload?.citations) ? payload.citations : []
        for (const citation of list) {
            const row = asRecord(citation)
            if (!row || typeof row.title !== "string") continue
            citations.push({
                title: row.title,
                ...(typeof row.href === "string" ? { href: row.href } : {}),
                ...(typeof row.domain === "string" ? { domain: row.domain } : {}),
                ...(typeof row.snippet === "string" ? { snippet: row.snippet } : {}),
            })
        }
    }
    return citations
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

export const researchSubagentTools: AssistantToolRegistration[] = [
    {
        name: SPAWN_RESEARCH_SUBAGENT,
        domain: "system",
        risk: "read",
        description: "派生子代理做只读深度检索（可跨知识库/文档库）。传入 goal 与 domains（仅 knowledge/doc_library/system）。返回 summary 与可选 citations；主助手据此作答，勿重复编造来源。",
        inputSchema: spawnSchema,
        execute: async (ctx, input) => await spawnResearchSubagent(ctx, input),
    },
]
