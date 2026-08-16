import { desc, eq } from "drizzle-orm"
import { Agent } from "@mastra/core/agent"
import { createChatLanguageModel } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { assistantRuns, assistantSteps } from "@/server/db/schema"
import type { AssistantToolContext } from "../domain-types"
import { createToolResilienceController, ToolResilienceError, isPlaybookToolResult } from "../tool-resilience"
import { recordAssistantStep } from "../thread-logic"
import { loadMastraToolsForDomains } from "../tool-registry"
import type { AgentDomainId } from "../domain-types"

export type NestedAgentGenerateResult = {
    text: string
    toolResults?: unknown
    totalUsage?: unknown
    usage?: unknown
}

export type NestedAgentStepSummary = {
    toolName: string
    ok: boolean
    errorCode?: string | null
}

export type NestedAgentRunOptions = {
    ctx: AssistantToolContext
    agentId: string
    agentName: string
    description: string
    instructions: string
    domains: AgentDomainId[]
    filterToolNames: (names: string[]) => string[]
    /** 装载后可注入额外工具（如 propose_write_actions） */
    augmentTools?: (
        tools: Record<string, ReturnType<typeof loadMastraToolsForDomains>[string]>,
    ) => Record<string, ReturnType<typeof loadMastraToolsForDomains>[string]>
    prompt: string
    maxSteps: number
    timeoutMs: number
    stepPrefix: string
    timeoutErrorTag?: string
    signal?: AbortSignal
}

export async function nextNestedStepIndex(runId: number): Promise<number> {
    const [row] = await getDb()
        .select({ stepIndex: assistantSteps.stepIndex })
        .from(assistantSteps)
        .where(eq(assistantSteps.runId, runId))
        .orderBy(desc(assistantSteps.stepIndex))
        .limit(1)
    return (row?.stepIndex ?? -1) + 1
}

export function readNestedTotalTokens(output: { totalUsage?: unknown; usage?: unknown }): number {
    const total = asRecord(output.totalUsage)
    if (typeof total?.totalTokens === "number") return total.totalTokens
    if (typeof total?.total === "number") return total.total
    const usage = asRecord(output.usage)
    if (typeof usage?.totalTokens === "number") return usage.totalTokens
    return 0
}

export function asNestedRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

const asRecord = asNestedRecord

/** 运行嵌套 Agent：统一超时 Abort + step 记录，供 research/write 子代理复用。 */
export async function runNestedAgentGenerate(options: NestedAgentRunOptions): Promise<{
    output: NestedAgentGenerateResult
    toolCalls: number
    steps: NestedAgentStepSummary[]
}> {
    const [run] = await getDb()
        .select({ modelConfigId: assistantRuns.modelConfigId })
        .from(assistantRuns)
        .where(eq(assistantRuns.id, options.ctx.runId))
        .limit(1)

    const resilience = createToolResilienceController()
    const allTools = loadMastraToolsForDomains(options.domains, options.ctx, resilience)
    let tools: typeof allTools = {}
    for (const name of options.filterToolNames(Object.keys(allTools))) {
        tools[name] = allTools[name]!
    }
    if (options.augmentTools) {
        tools = options.augmentTools(tools)
    }

    let stepIndex = await nextNestedStepIndex(options.ctx.runId)
    let toolCalls = 0
    const steps: NestedAgentStepSummary[] = []

    const { model } = await createChatLanguageModel({
        userId: options.ctx.userId,
        modelRefId: run?.modelConfigId ?? null,
    })

    const agent = new Agent({
        id: options.agentId,
        name: options.agentName,
        description: options.description,
        model: model as never,
        instructions: options.instructions,
        tools,
    })

    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    options.signal?.addEventListener("abort", onOuterAbort)

    const timeoutTag = options.timeoutErrorTag ?? "subagent_timeout"
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const output = await Promise.race([
            agent.generate(options.prompt, {
                maxSteps: options.maxSteps,
                modelSettings: { temperature: 0.2 },
                activeTools: Object.keys(tools),
                abortSignal: controller.signal,
                hooks: {
                    afterToolCall: async ({
                        toolName,
                        input: toolInput,
                        output: toolOutput,
                        error,
                    }: {
                        toolName: string
                        input?: unknown
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
                        steps.push({
                            toolName,
                            ok: isSuccess,
                            ...(errorCode ? { errorCode } : {}),
                        })
                        await recordAssistantStep({
                            runId: options.ctx.runId,
                            stepIndex: stepIndex++,
                            toolName: `${options.stepPrefix}/${toolName}`,
                            input: toolInput ?? {},
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
                timer = setTimeout(() => {
                    controller.abort()
                    reject(new Error(timeoutTag))
                }, options.timeoutMs)
            }),
        ])

        return {
            output: output as NestedAgentGenerateResult,
            toolCalls,
            steps,
        }
    } finally {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener("abort", onOuterAbort)
    }
}
