import type { NextRequest } from "next/server"
import {
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    type UIMessage,
    type UIMessageChunk,
} from "ai"
import { z } from "zod"
import { createChatLanguageModel } from "@/server/ai/generation"
import { requireCurrentUser } from "@/server/auth/current-user"
import { HttpError, toErrorResponse } from "@/server/http/response"
import type { AgentDomainId } from "./domain-types"
import { readAgentFeatureFlags } from "./agent-runtime/config"
import { createAgentEventWriter } from "./agent-runtime/chat-bridge"
import { resolveRoutingHint } from "./agent-runtime/router-hint"
import { createAgentRunRecord, persistAgentRun } from "./agent-runtime/store"
import { PetrichorAgentRuntime } from "./agent-runtime/runtime"
import { detectComplexity } from "./agent-runtime/planner"
import "./agent-runtime/tools"
import { assistantChatLegacy } from "./chat-handler-legacy"
import { addToolToThreadDangerAllowlist } from "./confirmation-allowlist"
import { consumeAssistantConfirmation } from "./confirmation-store"
import {
    executeConfirmedDangerousAction,
    findPendingConfirmationExecution,
    patchConfirmationExecutionOutcome,
} from "./confirmation"
import { buildContextPack } from "./context-pack"
import { buildInstructionsWithContextExtras } from "./context-recall"
import { assertAssistantFocusOwnership } from "./focus-guard"
import { isAssistantOperator } from "./operator-gate"
import {
    assistantFocusSchema,
    assistantIdSchema,
    createAssistantRun,
    ensureAssistantThread,
    finishAssistantRun,
    listRecentIntentDomains,
    listRecentToolNames,
    persistAssistantMessage,
    recordAssistantStep,
    truncateAssistantThreadMessages,
} from "./thread-logic"

/**
 * Assistant Chat 入口（§3）。
 *
 * 本文件只负责：鉴权、请求解析、会话初始化、模型配置、调用 AgentRuntime、
 * 流式响应与错误边界。任何编排逻辑都不允许留在这里。
 *
 * AGENT_RUNTIME_V2=false 时回落到 chat-handler-legacy（回滚开关，§107）。
 */

const chatRequestSchema = z.object({
    threadId: assistantIdSchema.optional().nullable(),
    messages: z.array(z.unknown()).min(1),
    configId: assistantIdSchema.optional().nullable(),
    focus: assistantFocusSchema.optional().nullable(),
    /** 重试时指向被重试的 Run；用于审计与"这次是重试"的追溯（§162.24） */
    retryOfRunId: z.string().trim().min(1).max(64).optional().nullable(),
})

export const MAX_CONTEXT_TOKENS = 100_000

export { buildAssistantSystemPrompt } from "./system-prompt"

const runtime = new PetrichorAgentRuntime()

export async function assistantChat(request: NextRequest) {
    const requestStartedAt = Date.now()
    if (!readAgentFeatureFlags().runtimeV2) {
        return await assistantChatLegacy(request)
    }

    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const focus = input.focus ?? null

        await assertAssistantFocusOwnership(user.id, focus)

        const lastMessage = input.messages.at(-1)
        const goal = extractLastUserText(input.messages)
        const shouldPersistUser = Boolean(goal) && isUserRoleMessage(lastMessage)

        const thread = await ensureAssistantThread({
            userId: user.id,
            threadId: input.threadId ?? null,
            title: goal,
            focus,
        })

        if (shouldPersistUser) {
            // 编辑重提时客户端会截断后续消息：先对齐库中历史，再写入本轮 user
            await truncateAssistantThreadMessages({
                threadId: thread.id,
                keepCount: Math.max(0, input.messages.length - 1),
            })
            await persistAssistantMessage({
                userId: user.id,
                threadId: thread.id,
                role: "user",
                content: lastMessage,
                titleCandidate: goal,
            })
        }

        const { model, resolved } = await resolveAssistantModel(user.id, input.configId ?? null)

        const [recentToolNames, recentIntentDomains] = await Promise.all([
            listRecentToolNames(thread.id),
            listRecentIntentDomains(thread.id),
        ])
        const routingHint = await resolveRoutingHint({
            userText: goal,
            focus,
            recentToolNames,
            recentIntentDomains,
        })

        const dbRun = await createAssistantRun({
            threadId: thread.id,
            modelConfigId: resolved.model.id,
            intentDomains: (routingHint?.domains ?? []) as AgentDomainId[],
        })

        // 危险操作确认回传：先按票据执行，再把结果回填进消息，Agent 据此继续推理（§132）
        let messagesForModel = input.messages as unknown[]
        const pendingConfirmation = findPendingConfirmationExecution(messagesForModel)
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
                const outcome = await executeConfirmedDangerousAction(
                    {
                        userId: user.id,
                        threadId: thread.id,
                        runId: dbRun.id,
                        focus,
                        systemRole: user.systemRole,
                        abortSignal: request.signal,
                    },
                    serverAction,
                )
                messagesForModel = patchConfirmationExecutionOutcome(
                    messagesForModel,
                    pendingConfirmation.confirmationId,
                    outcome,
                )
            } catch (error) {
                messagesForModel = patchConfirmationExecutionOutcome(
                    messagesForModel,
                    pendingConfirmation.confirmationId,
                    { error: error instanceof Error ? error.message : String(error) },
                )
            }
        }

        const conversationId = String(thread.id)
        const complexity = detectComplexity({
            goal,
            routingHint,
            turnCount: input.messages.length,
            hasFocus: Boolean(focus),
        }).complexity

        let runKey = ""
        let stepIndex = 0
        let dbRunFinalized = false
        const finishDbRun = async (status: "COMPLETED" | "FAILED", errorCode?: string) => {
            if (dbRunFinalized) return
            dbRunFinalized = true
            await finishAssistantRun({ runId: dbRun.id, status, errorCode })
        }

        return createUIMessageStreamResponse({
            stream: createUIMessageStream<UIMessage>({
                originalMessages: input.messages as UIMessage[],
                execute: async ({ writer }) => {
                    const events = createAgentEventWriter({
                        write: (chunk) => writer.write(chunk as UIMessageChunk),
                    })

                    // 上下文包沿用既有摘要/召回能力；Runtime 的 ContextManager 再做预算裁剪
                    const pack = await buildContextPack({
                        userId: user.id,
                        threadId: thread.id,
                        messages: messagesForModel as UIMessage[],
                        tokenBudget: MAX_CONTEXT_TOKENS,
                        modelRefId: resolved.model.id,
                        signal: request.signal,
                    })
                    const modelMessages = await convertToModelMessages(pack.recentMessages)
                    // buildContextPack 已负责持久摘要与相关历史召回。旧实现随后又跑一次
                    // summarizeConversation，不仅重复一次 LLM，还丢掉了 pack 中真正持久化的背景。
                    const conversationBackground = buildInstructionsWithContextExtras(
                        "",
                        pack.summaryMd,
                        pack.recalledSnippets,
                    ).trim()

                    try {
                        const result = await runtime.run({
                            conversationId,
                            userId: user.id,
                            dbRunId: dbRun.id,
                            threadId: thread.id,
                            systemRole: user.systemRole,
                            focus,
                            goal,
                            messages: modelMessages as unknown[],
                            ...(conversationBackground ? { conversationBackground } : {}),
                            model,
                            modelName: String(resolved.model.modelId ?? resolved.model.id),
                            startedAt: requestStartedAt,
                            ...(routingHint ? { routingHint } : {}),
                            turnCount: input.messages.length,
                            abortSignal: request.signal,
                            injectionGuard: {
                                providerKey: resolved.provider.providerKey,
                                modelId: resolved.model.modelId,
                            },
                            isOperator: isAssistantOperator({ id: user.id, systemRole: user.systemRole }),
                            contextTokenLimit: MAX_CONTEXT_TOKENS,
                            // 兼容既有 assistant_step 表：listRecentToolNames 与历史 UI 都依赖它（§108）
                            onToolTrace: (toolTrace) => {
                                void recordAssistantStep({
                                    runId: dbRun.id,
                                    stepIndex: stepIndex++,
                                    toolName: toolTrace.toolName,
                                    input: toolTrace.input ?? {},
                                    output: toolTrace.ok
                                        ? toolTrace.rawOutput ?? { summary: toolTrace.summary }
                                        : { error: toolTrace.summary, errorCode: toolTrace.errorCode },
                                    status: toolTrace.ok ? "COMPLETED" : "FAILED",
                                    errorCode: toolTrace.errorCode ?? null,
                                    durationMs: toolTrace.durationMs,
                                }).catch((error: unknown) => {
                                    console.error(JSON.stringify({
                                        level: "error",
                                        scope: "assistant.chat.recordStep",
                                        message: error instanceof Error ? error.message : String(error),
                                    }))
                                })
                            },
                            onEvent: (event) => {
                                if (!runKey) {
                                    runKey = event.runId
                                    void createAgentRunRecord({
                                        runKey: event.runId,
                                        conversationId,
                                        threadId: thread.id,
                                        userId: user.id,
                                        model: String(resolved.model.modelId ?? resolved.model.id),
                                        goal,
                                        complexity,
                                        ...(input.retryOfRunId ? { retryOfRunKey: input.retryOfRunId } : {}),
                                    })
                                }
                                events.onEvent(event)
                            },
                        })

                        events.finalize()
                        await finishDbRun(result.state.status === "failed" ? "FAILED" : "COMPLETED")
                        // 落库不阻塞流关闭；失败只记录日志（fail-open）
                        await persistAgentRun({
                            state: result.state,
                            trace: result.trace,
                            answer: result.answer,
                            evaluation: result.evaluation,
                            evidence: result.state.evidence,
                        })
                    } catch (error) {
                        events.finalize()
                        await finishDbRun("FAILED", "agent_runtime_error")
                        throw error
                    }
                },
                onEnd: async ({ responseMessage }) => {
                    await persistAssistantMessage({
                        userId: user.id,
                        threadId: thread.id,
                        role: "assistant",
                        content: {
                            parts: responseMessage.parts,
                            ...(runKey ? { agentRunId: runKey } : {}),
                        },
                    })
                },
            }),
            headers: {
                "X-Petrichor-Assistant-Thread-Id": String(thread.id),
                "X-Petrichor-Assistant-Run-Id": String(dbRun.id),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
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

export function extractLastUserText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: unknown; content?: unknown; parts?: unknown }
        if (message?.role !== "user") continue
        if (typeof message.content === "string" && message.content.trim()) return message.content.trim()
        const parts = Array.isArray(message.parts)
            ? message.parts
            : Array.isArray(message.content)
                ? message.content
                : []
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
