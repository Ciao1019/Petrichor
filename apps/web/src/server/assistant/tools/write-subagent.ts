import { desc, eq } from "drizzle-orm"
import { createTool } from "@mastra/core/tools"
import { Agent } from "@mastra/core/agent"
import { z } from "zod"
import { createChatLanguageModel } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { assistantRuns, assistantSteps } from "@/server/db/schema"
import type { AgentDomainId, AssistantFocus, AssistantToolContext, AssistantToolRegistration } from "../domain-types"
import { loadMastraToolsForDomains } from "../tool-registry"
import { createToolResilienceController, ToolResilienceError, isPlaybookToolResult } from "../tool-resilience"
import { assistantFocusSchema, recordAssistantStep } from "../thread-logic"
import { SPAWN_RESEARCH_SUBAGENT } from "./research-subagent"

export const SPAWN_WRITE_SUBAGENT = "spawn_write_subagent"
export const PROPOSE_WRITE_ACTIONS = "propose_write_actions"
export const WRITE_SUBAGENT_MAX_STEPS = 6
export const WRITE_SUBAGENT_TIMEOUT_MS = 90_000

/** 允许写入提案的工具 → risk（不含 admin） */
export const WRITE_PROPOSAL_TOOL_RISK = {
    create_article: "write",
    update_article: "write",
    create_article_share: "write",
    delete_article: "dangerous",
    revoke_article_share: "dangerous",
    delete_document: "dangerous",
} as const satisfies Record<string, "write" | "dangerous">

export type WriteProposalRisk = (typeof WRITE_PROPOSAL_TOOL_RISK)[keyof typeof WRITE_PROPOSAL_TOOL_RISK]

export type ProposedWriteAction = {
    toolName: string
    input: Record<string, unknown>
    reason?: string
    risk: WriteProposalRisk
}

const proposedActionSchema = z.object({
    toolName: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    reason: z.string().trim().max(500).optional(),
})

const spawnWriteSchema = z.object({
    goal: z.string().trim().min(1).max(2000),
    focus: assistantFocusSchema.optional().nullable(),
    proposedActions: z.array(proposedActionSchema).max(8).optional(),
})

export const spawnWriteInputSchema = spawnWriteSchema

export type SpawnWriteResult = {
    ok: boolean
    summary: string
    proposedActions: ProposedWriteAction[]
    usage?: { calls: number; totalTokens: number }
    errorCode?: string | null
}

const WRITE_SUBAGENT_DOMAINS: AgentDomainId[] = ["knowledge", "doc_library", "system"]

const BLOCKED_WRITE_SUBAGENT_TOOLS = new Set([
    SPAWN_WRITE_SUBAGENT,
    SPAWN_RESEARCH_SUBAGENT,
    "save_answer_artifact",
    "upsert_plan",
    "request_user_confirmation",
    "create_article",
    "update_article",
    "create_article_share",
    "delete_article",
    "revoke_article_share",
    "delete_document",
    "set_default_ai_config",
    "list_ai_configs",
    "list_agent_api_keys",
    "get_public_qa_setting",
])

export function filterWriteSubagentToolNames(toolNames: string[]): string[] {
    return toolNames.filter((name) => !BLOCKED_WRITE_SUBAGENT_TOOLS.has(name))
}

export function normalizeProposedWriteActions(
    actions: Array<{ toolName: string; input: Record<string, unknown>; reason?: string }> | undefined,
): ProposedWriteAction[] {
    if (!actions?.length) return []
    const normalized: ProposedWriteAction[] = []
    const seen = new Set<string>()
    for (const action of actions) {
        const risk = WRITE_PROPOSAL_TOOL_RISK[action.toolName as keyof typeof WRITE_PROPOSAL_TOOL_RISK]
        if (!risk) continue
        const key = `${action.toolName}:${JSON.stringify(action.input)}`
        if (seen.has(key)) continue
        seen.add(key)
        normalized.push({
            toolName: action.toolName,
            input: action.input,
            ...(action.reason ? { reason: action.reason } : {}),
            risk,
        })
        if (normalized.length >= 8) break
    }
    return normalized
}

function buildWriteSubagentInstructions(
    goal: string,
    seedActions: ProposedWriteAction[],
): string {
    const lines = [
        "你是 Petrichor 站内「写意图」研究子代理：只读检索，规划写入方案，不直接改数据。",
        "禁止声称已创建/更新/删除/分享；没有写入工具，不要假装调用。",
        "用 search/read 核实目标后，必须调用 propose_write_actions 提交拟执行操作（可含 create/update/share 与需确认的删除类）。",
        "最终用中文给出简洁方案说明。",
        `本轮目标：${goal}`,
    ]
    if (seedActions.length > 0) {
        lines.push(`主助手预置提案（可修订后通过 propose_write_actions 提交）：${JSON.stringify(seedActions)}`)
    }
    return lines.join("\n")
}

function createProposeWriteActionsTool(bucket: { actions: ProposedWriteAction[] }) {
    return createTool({
        id: PROPOSE_WRITE_ACTIONS,
        description:
            "向主助手提交拟执行的内容写入/危险操作清单。本工具不会真正执行；危险项须由主助手走 request_user_confirmation。",
        inputSchema: z.object({
            actions: z.array(proposedActionSchema).min(1).max(8),
        }),
        execute: async (input: unknown) => {
            const parsed = z.object({ actions: z.array(proposedActionSchema).min(1).max(8) }).parse(input)
            const actions = normalizeProposedWriteActions(parsed.actions)
            bucket.actions = actions
            return {
                ok: actions.length > 0,
                accepted: actions.length,
                rejected: parsed.actions.length - actions.length,
                actions,
                message: actions.length > 0
                    ? "提案已记录，等待主助手执行或确认。"
                    : "没有合法提案（工具名不在白名单）。",
            }
        },
    })
}

export async function spawnWriteSubagent(
    ctx: AssistantToolContext,
    raw: unknown,
): Promise<SpawnWriteResult> {
    const input = spawnWriteSchema.parse(raw ?? {})
    const seedActions = normalizeProposedWriteActions(input.proposedActions)
    const focus = (input.focus ?? ctx.focus) as AssistantFocus | null
    const proposalBucket = { actions: [...seedActions] as ProposedWriteAction[] }

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
    const allTools = loadMastraToolsForDomains(WRITE_SUBAGENT_DOMAINS, subCtx, resilience)
    const tools: Record<string, ReturnType<typeof createTool>> = {}
    for (const name of filterWriteSubagentToolNames(Object.keys(allTools))) {
        tools[name] = allTools[name]!
    }
    tools[PROPOSE_WRITE_ACTIONS] = createProposeWriteActionsTool(proposalBucket)

    let stepIndex = await nextStepIndex(ctx.runId)
    let toolCalls = 0

    try {
        const { model } = await createChatLanguageModel({
            userId: ctx.userId,
            configId: run?.modelConfigId ?? null,
        })

        const agent = new Agent({
            id: "petrichor-write-subagent",
            name: "Petrichor Write Subagent",
            description: "Read-only planner for content write intents; proposes actions for the main agent.",
            model: model as never,
            instructions: buildWriteSubagentInstructions(input.goal, seedActions),
            tools,
        })

        const output = await Promise.race([
            agent.generate(input.goal, {
                maxSteps: WRITE_SUBAGENT_MAX_STEPS,
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
                        const playbook = isPlaybookToolResult(toolOutput) ? toolOutput : null
                        const isSuccess = error == null && meta?.errorCode == null && !playbook
                        const errorCode = isSuccess
                            ? null
                            : meta?.errorCode
                                ?? playbook?.errorCode
                                ?? (error instanceof ToolResilienceError ? error.code : "tool_error")
                        await recordAssistantStep({
                            runId: ctx.runId,
                            stepIndex: stepIndex++,
                            toolName: `${SPAWN_WRITE_SUBAGENT}/${toolName}`,
                            input: {},
                            output: isSuccess
                                ? toolOutput
                                : playbook ?? {
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
                setTimeout(() => reject(new Error("write_subagent_timeout")), WRITE_SUBAGENT_TIMEOUT_MS)
            }),
        ])

        const summary = typeof output.text === "string" ? output.text.trim() : ""
        const proposedActions = proposalBucket.actions
        const ok = Boolean(summary) || proposedActions.length > 0

        return {
            ok,
            summary: summary || (proposedActions.length > 0 ? "已生成写入提案，请主助手执行或确认。" : "写子代理未产出方案"),
            proposedActions,
            usage: { calls: toolCalls, totalTokens: readTotalTokens(output) },
            errorCode: ok ? null : "empty_write_plan",
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const errorCode = message.includes("write_subagent_timeout") ? "tool_timeout" : "tool_error"
        return {
            ok: false,
            summary: `写子代理失败：${message}`,
            proposedActions: proposalBucket.actions,
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

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

export const writeSubagentTools: AssistantToolRegistration[] = [
    {
        name: SPAWN_WRITE_SUBAGENT,
        domain: "content_write",
        risk: "read",
        description:
            "派生子代理规划内容写入方案（只读检索 + 提案）。传入 goal；可选 proposedActions 预置。返回 summary 与 proposedActions（含 risk）。写操作由主助手执行；危险项必须 request_user_confirmation，子代理不会直接改数据。",
        inputSchema: spawnWriteSchema,
        execute: async (ctx, input) => await spawnWriteSubagent(ctx, input),
    },
]
