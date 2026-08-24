import type { AppRequest } from "@/server/http/request"
import {
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    type LanguageModel,
    type UIMessage,
    type UIMessageChunk,
} from "ai"
import { toAISdkStream } from "@mastra/ai-sdk"
import { Agent } from "@mastra/core/agent"
import { PromptInjectionDetector, TokenLimiterProcessor } from "@mastra/core/processors"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { createChatLanguageModel } from "@/server/ai/generation"
import { needsJsonPromptInjectionForStructuredOutput } from "@/server/ai/provider-quirks"
import { HttpError, toErrorResponse } from "@/server/http/response"
import type { AssistantToolContext, StepBudgetPartData } from "./domain-types"
import {
    resolveAssistantMaxSteps,
    resolveToolLoadDomains,
    STEP_BUDGET_PART_TYPE,
    stripStepBudgetWarnings,
} from "./domain-types"
import { assertAssistantFocusOwnership } from "./focus-guard"
import {
    dedupeIntentRouteParts,
    domainsEqual,
    INTENT_ROUTE_PART_TYPE,
    needsIntentLlm,
    routeAssistantIntentWithLlm,
    toIntentRoutePartData,
    type IntentRoutePartData,
    type IntentRouteUiResult,
} from "./intent-llm"
import { routeAssistantIntent } from "./intent-router"
import "./tools"
import {
    executeConfirmedDangerousAction,
    findPendingConfirmationExecution,
    patchConfirmationExecutionOutcome,
} from "./confirmation"
import { consumeAssistantConfirmation } from "./confirmation-store"
import { addToolToThreadDangerAllowlist } from "./confirmation-allowlist"
import {
    buildContextPack,
    buildInstructionsWithContextSummary,
    CONTEXT_COMPRESS_PART_TYPE,
    stripContextCompressParts,
    type ContextCompressPartData,
} from "./context-pack"
import { isAssistantOperator } from "./operator-gate"
import { loadOperatorMemoryPromptSection } from "./operator-memory"
import { listOperatorSkillCatalog } from "./operator-skills"
import { loadMastraToolsForDomains } from "./tool-registry"
import { resolveAssistantSkills } from "./skills"
import { buildAssistantSystemPrompt } from "./system-prompt"
import { createToolResilienceController, ToolResilienceError, isPlaybookToolResult } from "./tool-resilience"
import { flattenAssistantUsage } from "./usage-meta"
import {
    assistantFocusSchema,
    assistantIdSchema,
    createAssistantRun,
    ensureAssistantThread,
    finishAssistantRun,
    listRecentToolNames,
    listRecentIntentDomains,
    persistAssistantMessage,
    recordAssistantStep,
    truncateAssistantThreadMessages,
    updateAssistantRunIntent,
} from "./thread-logic"

const chatRequestSchema = z.object({
    threadId: assistantIdSchema.optional().nullable(),
    messages: z.array(z.unknown()).min(1),
    configId: assistantIdSchema.optional().nullable(),
    focus: assistantFocusSchema.optional().nullable(),
})

export const MAX_CONTEXT_TOKENS = 100_000

type AgentModelConfig = ConstructorParameters<typeof Agent>[0]["model"]
type ProcessorModel = ConstructorParameters<typeof PromptInjectionDetector>[0]["model"]

export { buildAssistantSystemPrompt } from "./system-prompt"

export async function assistantChatLegacy(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const focus = input.focus ?? null

        await assertAssistantFocusOwnership(user.id, focus)

        const lastUserText = extractLastUserText(input.messages)
        const lastMessage = input.messages.at(-1)
        const shouldPersistUser = Boolean(lastUserText) && isUserRoleMessage(lastMessage)
        const thread = await ensureAssistantThread({
            userId: user.id,
            threadId: input.threadId ?? null,
            title: lastUserText,
            focus,
        })

        if (shouldPersistUser) {
            // 编辑重提时客户端会截断后续消息；先对齐删除库中多余历史，再写入本轮 user
            await truncateAssistantThreadMessages({
                threadId: thread.id,
                keepCount: Math.max(0, input.messages.length - 1),
            })
            await persistAssistantMessage({
                userId: user.id,
                threadId: thread.id,
                role: "user",
                content: lastMessage,
                titleCandidate: lastUserText,
            })
        }

        const { model, resolved } = await resolveAssistantModel(user.id, input.configId ?? null)

        const recentToolNames = await listRecentToolNames(thread.id)
        const recentIntentDomains = await listRecentIntentDomains(thread.id)
        // 先规则占位，保证响应头立刻有 Run-Id；stream 内低置信度 LLM 可覆盖并回写
        const rulesRoute = await routeAssistantIntent({
            userText: lastUserText,
            focus,
            recentToolNames,
            recentIntentDomains,
        })
        const run = await createAssistantRun({
            threadId: thread.id,
            modelConfigId: resolved.model.id,
            intentDomains: rulesRoute.domains,
        })

        const isOperator = isAssistantOperator({ id: user.id, systemRole: user.systemRole })
        const toolContext: AssistantToolContext = {
            userId: user.id,
            threadId: thread.id,
            runId: run.id,
            focus,
            systemRole: user.systemRole,
            abortSignal: request.signal,
        }
        const resilience = createToolResilienceController()

        let messagesForModel = input.messages as unknown[]
        const pendingConfirmation = findPendingConfirmationExecution(messagesForModel)
        /** 确认回传且本轮未追加新 user 消息 → 轻量 resume（跳过意图 LLM / 摘要刷新） */
        const isConfirmationResume = Boolean(pendingConfirmation) && !shouldPersistUser
        if (pendingConfirmation) {
            try {
                const serverAction = await consumeAssistantConfirmation({
                    confirmationKey: pendingConfirmation.confirmationId,
                    userId: user.id,
                    threadId: thread.id,
                })
                if (pendingConfirmation.allowForThread) {
                    await addToolToThreadDangerAllowlist({
                        threadId: thread.id,
                        userId: user.id,
                        toolName: serverAction.toolName,
                    })
                }
                const outcome = await executeConfirmedDangerousAction(toolContext, serverAction)
                messagesForModel = patchConfirmationExecutionOutcome(
                    messagesForModel,
                    pendingConfirmation.confirmationId,
                    outcome,
                )
                await recordAssistantStep({
                    runId: run.id,
                    stepIndex: 0,
                    toolName: serverAction.toolName,
                    input: serverAction.input,
                    output: outcome,
                    status: "COMPLETED",
                    errorCode: null,
                    durationMs: null,
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                messagesForModel = patchConfirmationExecutionOutcome(
                    messagesForModel,
                    pendingConfirmation.confirmationId,
                    { error: message },
                )
                await recordAssistantStep({
                    runId: run.id,
                    stepIndex: 0,
                    toolName: "request_user_confirmation",
                    input: { confirmationId: pendingConfirmation.confirmationId },
                    output: { error: message },
                    status: "FAILED",
                    errorCode: "tool_error",
                    durationMs: null,
                })
            }
        }

        let runFinalized = false
        const finishRunOnce = async (status: "COMPLETED" | "FAILED", errorCode?: string) => {
            if (runFinalized) return
            runFinalized = true
            await finishAssistantRun({ runId: run.id, status, errorCode })
        }

        let stepIndex = pendingConfirmation ? 1 : 0
        let streamStartedAt: number | undefined

        return createUIMessageStreamResponse({
            stream: createUIMessageStream<UIMessage>({
                originalMessages: input.messages as UIMessage[],
                execute: async ({ writer }) => {
                    const intentId = "intent-route"
                    const writeIntent = (data: IntentRoutePartData, transient = false) => {
                        writer.write({
                            type: INTENT_ROUTE_PART_TYPE,
                            id: intentId,
                            data,
                            ...(transient ? { transient: true } : {}),
                        } as UIMessageChunk)
                    }

                    // running 用 transient，避免与 done 在 id 合并失败时各占一条 part（UI 会双份芯片）
                    if (!isConfirmationResume && needsIntentLlm(rulesRoute)) {
                        writeIntent({ status: "running", label: "正在识别意图…" }, true)
                    }

                    const compressId = "context-compress"
                    const writeCompress = (data: ContextCompressPartData) => {
                        writer.write({
                            type: CONTEXT_COMPRESS_PART_TYPE,
                            id: compressId,
                            data,
                        } as UIMessageChunk)
                    }

                    const stepBudgetId = "step-budget"
                    const writeStepBudget = (data: StepBudgetPartData) => {
                        writer.write({
                            type: STEP_BUDGET_PART_TYPE,
                            id: stepBudgetId,
                            data,
                        } as UIMessageChunk)
                    }

                    // 意图路由与 context pack 互不依赖，并行以降低首 token 前串行阻塞
                    const [finalRoute, pack] = await Promise.all([
                        isConfirmationResume
                            ? Promise.resolve({
                                ...rulesRoute,
                                source: "rules" as const,
                                rationale: `${rulesRoute.rationale ?? "rules"};confirmation-resume`,
                            } satisfies IntentRouteUiResult)
                            : routeAssistantIntentWithLlm({
                                userText: lastUserText,
                                focus,
                                recentToolNames,
                                recentIntentDomains,
                                model: model as LanguageModel,
                                signal: request.signal,
                                rulesRoute,
                            }),
                        buildContextPack({
                            userId: user.id,
                            threadId: thread.id,
                            messages: messagesForModel as UIMessage[],
                            tokenBudget: MAX_CONTEXT_TOKENS,
                            modelRefId: resolved.model.id,
                            signal: request.signal,
                            skipRefresh: isConfirmationResume,
                            onCompressStart: () => {
                                writeCompress({
                                    status: "running",
                                    label: "正在整理对话上下文…",
                                })
                            },
                        }),
                    ])
                    writeIntent(toIntentRoutePartData(finalRoute, "done"))

                    if (!domainsEqual(finalRoute.domains, rulesRoute.domains)) {
                        await updateAssistantRunIntent({
                            runId: run.id,
                            intentDomains: finalRoute.domains,
                        })
                    }

                    // Claude Code 风格：核心域（含 content_write）常驻；admin 仍按意图按需。
                    // 意图芯片仍展示 finalRoute；实际工具/skill/提示用 toolDomains。
                    const toolDomains = resolveToolLoadDomains(finalRoute.domains)
                    const maxSteps = resolveAssistantMaxSteps(finalRoute.domains)
                    let toolCallCount = 0
                    let stepBudgetWarned = false
                    const tools = loadMastraToolsForDomains(toolDomains, toolContext, resilience, { isOperator })
                    const activeToolNames = Object.keys(tools)
                    const skills = resolveAssistantSkills(toolDomains)

                    if (pack.status === "done" || pack.status === "failed") {
                        writeCompress({
                            status: pack.status === "done" ? "done" : "failed",
                            label: pack.status === "done"
                                ? "上下文已整理"
                                : "上下文整理未完成，继续回答",
                        })
                    }

                    const basePrompt = buildAssistantSystemPrompt(
                        toolDomains,
                        isOperator
                            ? await listOperatorSkillCatalog(
                                { id: user.id, systemRole: user.systemRole },
                                toolDomains,
                            )
                            : undefined,
                    )
                    const memorySection = await loadOperatorMemoryPromptSection(
                        { id: user.id, systemRole: user.systemRole },
                        thread.id,
                    )
                    const promptWithMemory = memorySection
                        ? `${memorySection}\n\n${basePrompt}`
                        : basePrompt

                    const agent = new Agent({
                        id: "petrichor-assistant",
                        name: "Petrichor Assistant",
                        description: "In-site universal assistant for system overview, knowledge bases, and document libraries.",
                        model: model as unknown as AgentModelConfig,
                        instructions: buildInstructionsWithContextSummary(
                            promptWithMemory,
                            pack.summaryMd,
                            pack.recalledSnippets,
                        ),
                        tools,
                        skills,
                        inputProcessors: process.env.VITEST
                            ? [new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" })]
                            : [
                                new PromptInjectionDetector({
                                    model: model as unknown as ProcessorModel,
                                    strategy: "block",
                                    threshold: 0.85,
                                    detectionTypes: ["injection", "jailbreak", "system-override"],
                                    lastMessageOnly: true,
                                    ...(needsJsonPromptInjectionForStructuredOutput(
                                        resolved.provider.providerKey,
                                        resolved.model.modelId,
                                    )
                                        ? { structuredOutputOptions: { jsonPromptInjection: true } }
                                        : {}),
                                }),
                                new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" }),
                            ],
                    })

                    const modelMessages = await convertToModelMessages(pack.recentMessages)
                    streamStartedAt = Date.now()
                    const result = await agent.stream(modelMessages as never, {
                        maxSteps,
                        modelSettings: { temperature: 0.2 },
                        activeTools: activeToolNames,
                        abortSignal: request.signal,
                        hooks: {
                            afterToolCall: async ({ toolName, input: toolInput, output, error }) => {
                                toolCallCount += 1
                                if (!stepBudgetWarned && toolCallCount >= maxSteps - 1) {
                                    stepBudgetWarned = true
                                    writeStepBudget({
                                        status: "warning",
                                        used: toolCallCount,
                                        limit: maxSteps,
                                        label: `本轮步数将尽（${toolCallCount}/${maxSteps}），复杂任务可分多轮继续`,
                                    })
                                }
                                const meta = resilience.consumeMeta(toolName)
                                const playbook = isPlaybookToolResult(output) ? output : null
                                const isSuccess = error == null && meta?.errorCode == null && !playbook
                                const errorCode = isSuccess
                                    ? null
                                    : meta?.errorCode
                                        ?? playbook?.errorCode
                                        ?? (error instanceof ToolResilienceError ? error.code : "tool_error")
                                await recordAssistantStep({
                                    runId: run.id,
                                    stepIndex: stepIndex++,
                                    toolName,
                                    input: toolInput ?? {},
                                    output: isSuccess
                                        ? output
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
                        onFinish: async (event) => {
                            if (toolCallCount >= maxSteps) {
                                writeStepBudget({
                                    status: "exhausted",
                                    used: toolCallCount,
                                    limit: maxSteps,
                                    label: "本轮步数已用尽，可继续发消息接着做",
                                })
                            }
                            const error = event.error
                            await finishRunOnce(
                                error ? "FAILED" : "COMPLETED",
                                error ? "stream_error" : undefined,
                            )
                        },
                        onError: async () => {
                            await finishRunOnce("FAILED", "stream_error")
                        },
                    })

                    const mastraUiStream = toAISdkStream(result, {
                        from: "agent",
                        version: "v6",
                        // finish 上的 totalUsage 转 UI chunk 时会被剥掉；经 messageMetadata 注入 custom.usage
                        messageMetadata: ({ part }) => {
                            if (!part || typeof part !== "object") return undefined
                            const record = part as { type?: unknown; totalUsage?: unknown; usage?: unknown }
                            if (record.type !== "finish") return undefined
                            const usage = flattenAssistantUsage(record.totalUsage ?? record.usage)
                            if (!usage) return undefined
                            return { custom: { usage } }
                        },
                    })
                    const reader = mastraUiStream.getReader()
                    try {
                        while (true) {
                            const { done, value } = await reader.read()
                            if (done) break
                            writer.write(value as UIMessageChunk)
                        }
                    } catch {
                        await finishRunOnce("FAILED", "stream_aborted")
                        throw new Error("assistant stream aborted")
                    } finally {
                        reader.releaseLock()
                    }
                },
                onEnd: async ({ responseMessage }) => {
                    const parts = dedupeIntentRouteParts(
                        stripStepBudgetWarnings(stripContextCompressParts(responseMessage.parts)),
                    )
                    const metadata = (responseMessage as { metadata?: unknown }).metadata
                    const metaRecord = typeof metadata === "object" && metadata !== null
                        ? metadata as Record<string, unknown>
                        : null
                    const custom = typeof metaRecord?.custom === "object" && metaRecord.custom !== null
                        ? metaRecord.custom as Record<string, unknown>
                        : null
                    const usage = flattenAssistantUsage(custom?.usage ?? metaRecord?.usage)
                    const totalStreamTime = typeof streamStartedAt === "number"
                        ? Math.max(0, Date.now() - streamStartedAt)
                        : undefined
                    const outputTokens = usage?.outputTokens
                    const tokensPerSecond = totalStreamTime && totalStreamTime > 0 && outputTokens != null && outputTokens > 0
                        ? outputTokens / (totalStreamTime / 1000)
                        : undefined
                    await persistAssistantMessage({
                        userId: user.id,
                        threadId: thread.id,
                        role: "assistant",
                        content: {
                            parts,
                            ...(usage ? { usage } : {}),
                            ...(totalStreamTime != null ? { totalStreamTime } : {}),
                            ...(tokensPerSecond != null ? { tokensPerSecond } : {}),
                        },
                    })
                },
            }),
            headers: {
                "X-Petrichor-Assistant-Thread-Id": String(thread.id),
                "X-Petrichor-Assistant-Run-Id": String(run.id),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

async function resolveAssistantModel(userId: number, modelRefId: number | null) {
    try {
        return await createChatLanguageModel({ userId, modelRefId })
    } catch (error) {
        if (error instanceof HttpError && (error.status === 400 || error.status === 404)) {
            throw new HttpError(409, error.message)
        }
        throw error
    }
}

function isUserRoleMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") return false
    return (message as { role?: unknown }).role === "user"
}

function extractLastUserText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: unknown; content?: unknown; parts?: unknown }
        if (message?.role !== "user") continue
        if (typeof message.content === "string" && message.content.trim()) return message.content.trim()
        const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : []
        const text = parts
            .map((part) => {
                if (!part || typeof part !== "object") return ""
                const candidate = part as { type?: unknown; text?: unknown }
                return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
            })
            .filter(Boolean)
            .join("\n")
            .trim()
        if (text) return text
    }
    return ""
}
