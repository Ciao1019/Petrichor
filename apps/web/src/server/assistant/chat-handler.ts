import type { NextRequest } from "next/server"
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
import { needsJsonPromptInjectionForStructuredOutput } from "@/server/ai/protocol-adapters"
import type { AiProtocol } from "@/server/ai/config-logic"
import { HttpError, toErrorResponse } from "@/server/http/response"
import type { AgentDomainId, AssistantToolContext } from "./domain-types"
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
import {
    buildContextPack,
    buildInstructionsWithContextSummary,
    CONTEXT_COMPRESS_PART_TYPE,
    inspectContextCompressNeed,
    stripContextCompressParts,
    type ContextCompressPartData,
} from "./context-pack"
import { loadMastraToolsForDomains } from "./tool-registry"
import { resolveAssistantSkills } from "./skills"
import { createToolResilienceController, ToolResilienceError, isPlaybookToolResult } from "./tool-resilience"
import {
    assistantFocusSchema,
    assistantIdSchema,
    createAssistantRun,
    ensureAssistantThread,
    finishAssistantRun,
    listRecentToolNames,
    persistAssistantMessage,
    recordAssistantStep,
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

export function buildAssistantSystemPrompt(domains: AgentDomainId[]): string {
    const activeDomains = new Set(domains)
    const guidance: string[] = []

    if (activeDomains.has("system")) {
        guidance.push("系统元信息用 list_system_overview。多步任务用 show_progress / upsert_plan（侧栏展示，正文不重复罗列）。可复用结果才用 save_answer_artifact。")
        guidance.push("跨库或多步核验可用 spawn_research_subagent；多路子问题用 spawn_research_fanout（tasks≤3）。根据 summary/citations/results 作答，不编造来源。")
    }
    if (activeDomains.has("knowledge") || activeDomains.has("doc_library") || activeDomains.has("content_write") || activeDomains.has("admin")) {
        guidance.push("复杂业务步骤先用 skill 工具加载对应 playbook（knowledge-qa / doc-library-qa / article-write / admin-ops），再按 playbook 调用本轮工具。")
    }
    if (activeDomains.has("knowledge")) {
        guidance.push("图片/图表：答案中直接输出 Markdown 图片，src 用 media.src 原值（常为 s4key:…），禁止声称无法展示。")
    }
    if (activeDomains.has("system") && (activeDomains.has("knowledge") || activeDomains.has("doc_library"))) {
        guidance.push("最终答案基于工具结果，并调用 show_citations；引用字段不得改写或编造。")
    }
    if (activeDomains.has("content_write") || activeDomains.has("admin")) {
        guidance.push("危险操作必须 request_user_confirmation，禁止假装已执行。")
    }

    return [
        "你是 Petrichor 的站内助手，以对话方式帮助已登录用户查看和操作系统。",
        `本轮路由域：${domains.join(", ")}。只调用本轮实际提供的工具；没有对应写入或管理工具时，不要假装已经执行。`,
        ...guidance,
        "站内事实必须以工具结果为准；检索不到就如实说明，不要编造数据、来源、链接或原文片段。",
        "若工具返回 ok:false 且带 errorCode（tool_degraded / tool_circuit_open）与 message，按其中 action 换招或直接回答；已熔断的工具不要再调用。",
        "若某工具失败或超时，改用其他可用工具或降级说明，不要反复调用同一已失败工具。",
        "只使用中文回答，直接、结构清晰。",
    ].join("\n")
}

export async function assistantChat(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const focus = input.focus ?? null

        await assertAssistantFocusOwnership(user.id, focus)

        const lastUserText = extractLastUserText(input.messages)
        const thread = await ensureAssistantThread({
            userId: user.id,
            threadId: input.threadId ?? null,
            title: lastUserText,
            focus,
        })

        if (lastUserText) {
            await persistAssistantMessage({
                userId: user.id,
                threadId: thread.id,
                role: "user",
                content: input.messages.at(-1),
                titleCandidate: lastUserText,
            })
        }

        const { model, config } = await resolveAssistantModel(user.id, input.configId ?? null)

        const recentToolNames = await listRecentToolNames(thread.id)
        // 先规则占位，保证响应头立刻有 Run-Id；stream 内低置信度 LLM 可覆盖并回写
        const rulesRoute = await routeAssistantIntent({ userText: lastUserText, focus, recentToolNames })
        const run = await createAssistantRun({
            threadId: thread.id,
            modelConfigId: config.id,
            intentDomains: rulesRoute.domains,
        })

        const toolContext: AssistantToolContext = {
            userId: user.id,
            threadId: thread.id,
            runId: run.id,
            focus,
        }
        const resilience = createToolResilienceController()

        let messagesForModel = input.messages as unknown[]
        const pendingConfirmation = findPendingConfirmationExecution(messagesForModel)
        if (pendingConfirmation) {
            try {
                const outcome = await executeConfirmedDangerousAction(toolContext, pendingConfirmation.action)
                messagesForModel = patchConfirmationExecutionOutcome(
                    messagesForModel,
                    pendingConfirmation.confirmationId,
                    outcome,
                )
                await recordAssistantStep({
                    runId: run.id,
                    stepIndex: 0,
                    toolName: pendingConfirmation.action.toolName,
                    input: pendingConfirmation.action.input,
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
                    toolName: pendingConfirmation.action.toolName,
                    input: pendingConfirmation.action.input,
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
                    if (needsIntentLlm(rulesRoute)) {
                        writeIntent({ status: "running", label: "正在识别意图…" }, true)
                    }

                    const finalRoute: IntentRouteUiResult = await routeAssistantIntentWithLlm({
                        userText: lastUserText,
                        focus,
                        recentToolNames,
                        model: model as LanguageModel,
                        signal: request.signal,
                        rulesRoute,
                    })
                    writeIntent(toIntentRoutePartData(finalRoute, "done"))

                    if (!domainsEqual(finalRoute.domains, rulesRoute.domains)) {
                        await updateAssistantRunIntent({
                            runId: run.id,
                            intentDomains: finalRoute.domains,
                        })
                    }

                    const tools = loadMastraToolsForDomains(finalRoute.domains, toolContext, resilience)
                    const activeToolNames = Object.keys(tools)
                    const skills = resolveAssistantSkills(finalRoute.domains)

                    const compressId = "context-compress"
                    const writeCompress = (data: ContextCompressPartData) => {
                        writer.write({
                            type: CONTEXT_COMPRESS_PART_TYPE,
                            id: compressId,
                            data,
                        } as UIMessageChunk)
                    }

                    const need = await inspectContextCompressNeed({
                        userId: user.id,
                        threadId: thread.id,
                        messages: messagesForModel as UIMessage[],
                        tokenBudget: MAX_CONTEXT_TOKENS,
                    })
                    if (need.needsRefresh) {
                        writeCompress({
                            status: "running",
                            label: "正在整理对话上下文…",
                        })
                    }

                    const pack = await buildContextPack({
                        userId: user.id,
                        threadId: thread.id,
                        messages: messagesForModel as UIMessage[],
                        tokenBudget: MAX_CONTEXT_TOKENS,
                        configId: config.id,
                        signal: request.signal,
                    })

                    if (need.needsRefresh) {
                        writeCompress({
                            status: pack.status === "done" ? "done" : pack.status === "failed" ? "failed" : "skipped",
                            label: pack.status === "done"
                                ? "上下文已整理"
                                : pack.status === "failed"
                                    ? "上下文整理未完成，继续回答"
                                    : "无需整理上下文",
                        })
                    }

                    const agent = new Agent({
                        id: "petrichor-assistant",
                        name: "Petrichor Assistant",
                        description: "In-site universal assistant for system overview, knowledge bases, and document libraries.",
                        model: model as unknown as AgentModelConfig,
                        instructions: buildInstructionsWithContextSummary(
                            buildAssistantSystemPrompt(finalRoute.domains),
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
                                    ...(needsJsonPromptInjectionForStructuredOutput({
                                        protocol: config.protocol as AiProtocol,
                                        baseUrl: config.baseUrl ?? "",
                                        model: config.model,
                                        name: config.name,
                                    })
                                        ? { structuredOutputOptions: { jsonPromptInjection: true } }
                                        : {}),
                                }),
                                new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" }),
                            ],
                    })

                    const modelMessages = await convertToModelMessages(pack.recentMessages)
                    const result = await agent.stream(modelMessages as never, {
                        maxSteps: 8,
                        modelSettings: { temperature: 0.2 },
                        activeTools: activeToolNames,
                        abortSignal: request.signal,
                        hooks: {
                            afterToolCall: async ({ toolName, output, error }) => {
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
                                    input: {},
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
                    const parts = dedupeIntentRouteParts(stripContextCompressParts(responseMessage.parts))
                    await persistAssistantMessage({
                        userId: user.id,
                        threadId: thread.id,
                        role: "assistant",
                        content: { parts },
                    })
                },
            }),
            headers: {
                "X-Petrichor-Assistant-Thread-Id": String(thread.id),
                "X-Petrichor-Assistant-Run-Id": String(run.id),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

async function resolveAssistantModel(userId: number, configId: number | null) {
    try {
        return await createChatLanguageModel({ userId, configId })
    } catch (error) {
        if (error instanceof HttpError && (error.status === 400 || error.status === 404)) {
            throw new HttpError(409, error.message)
        }
        throw error
    }
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
