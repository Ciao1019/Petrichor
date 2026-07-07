import { after, type NextRequest } from "next/server"
import {
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    type UIMessage,
    type UIMessageChunk,
} from "ai"
import { toAISdkStream } from "@mastra/ai-sdk"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { createChatLanguageModel } from "@/server/ai/generation"
import { toErrorResponse } from "@/server/http/response"
import {
    assertKnowledgeBaseOwner,
    createAgentRun,
    ensureAgentThread,
    finishAgentRun,
    idSchema,
    persistAgentMessage,
    recordAgentStep,
} from "@/server/kb/wiki-agent-logic"
import { loadAgentMemoryPromptSection, maybeDistillAgentMemory } from "@/server/kb/agent-memory"
import { createKnowledgeQaMastraAgent } from "@/server/kb/knowledge-qa-mastra-agent"
import { getDb } from "@/server/db/client"

export const maxDuration = 300

const chatRequestSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    threadId: idSchema.optional().nullable(),
    messages: z.array(z.unknown()).min(1),
    configId: idSchema.optional().nullable(),
})

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const db = getDb()
        const knowledgeBaseId = input.knowledgeBaseId ?? null
        if (knowledgeBaseId != null) {
            await assertKnowledgeBaseOwner(db, user.id, knowledgeBaseId)
        }

        const thread = await ensureAgentThread({
            userId: user.id,
            knowledgeBaseId,
            threadId: input.threadId ?? null,
            title: extractLastUserText(input.messages) || "文档问答",
        })

        const lastUserText = extractLastUserText(input.messages)
        if (lastUserText) {
            await persistAgentMessage({
                userId: user.id,
                knowledgeBaseId,
                threadId: thread.id,
                role: "user",
                contentText: lastUserText,
                content: input.messages.at(-1),
            })
        }

        const { model, config } = await createChatLanguageModel({
            userId: user.id,
            configId: input.configId ?? null,
        })
        const run = await createAgentRun({
            userId: user.id,
            knowledgeBaseId,
            threadId: thread.id,
            modelName: config.model,
        })

        // 跨 thread 长期记忆：注入 Observer/Reflector 从历史对话维护出的用户观察（无记忆时为 null）
        const memorySection = await loadAgentMemoryPromptSection(user.id)
        const subAgentUsageAcc = createSubAgentUsageAccumulator()
        const { agent, activeToolNames } = createKnowledgeQaMastraAgent({
            userId: user.id,
            knowledgeBaseId,
            threadId: thread.id,
            runId: run.id,
            model,
            memorySection,
            onSubagentUsage: (usage) => addSubAgentUsage(subAgentUsageAcc, usage),
        })

        const inputTokenEstimate = estimateConversationInputTokens(input.messages)
        let assistantTextAccumulator = ""
        const streamStartedAt = Date.now()
        let firstTokenAtMs: number | null = null
        let chunkCount = 0
        let finalUsageMetadata: AssistantUsageMetadata | null = null
        let finalModelId: string | null = null
        let runFinalized = false
        const finishRunOnce = async (result: { status: "COMPLETED" | "FAILED"; errorMessage?: string }) => {
            if (runFinalized) return
            runFinalized = true
            if (result.status === "COMPLETED") {
                if (!finalUsageMetadata) {
                    // Fallback if messageMetadata callback didn't compute usage (e.g. stream aborted)
                    finalUsageMetadata = normalizeOrEstimateUsage({
                        usage: undefined,
                        inputTokenEstimate,
                        assistantText: assistantTextAccumulator,
                    })
                }
                await finishAgentRun({
                    runId: run.id,
                    userId: user.id,
                    status: "COMPLETED",
                })
                return
            }
            await finishAgentRun({
                runId: run.id,
                userId: user.id,
                status: "FAILED",
                errorMessage: result.errorMessage,
            })
        }

        const modelMessages = await convertToModelMessages(input.messages as UIMessage[])
        const result = await agent.stream(modelMessages as never, {
            maxSteps: 8,
            modelSettings: { temperature: 0.2 },
            activeTools: activeToolNames,
            abortSignal: request.signal,
            hooks: {
                afterToolCall: async ({ toolName, output, error }) => {
                    const isSuccess = error == null
                    await recordAgentStep({
                        runId: run.id,
                        userId: user.id,
                        knowledgeBaseId,
                        stepType: toolName,
                        title: isSuccess ? `完成工具：${toolName}` : `工具失败：${toolName}`,
                        status: isSuccess ? "COMPLETED" : "FAILED",
                        payload: isSuccess ? output : { error: error instanceof Error ? error.message : String(error) },
                    })
                },
            },
            onFinish: async (event) => {
                const error = event.error
                await finishRunOnce({
                    status: error ? "FAILED" : "COMPLETED",
                    errorMessage: error
                        ? error instanceof Error
                            ? error.message
                            : typeof error === "string"
                                ? error
                                : error.message
                        : undefined,
                })
            },
            onError: async ({ error }) => {
                await finishRunOnce({
                    status: "FAILED",
                    errorMessage: error instanceof Error ? error.message : String(error),
                })
            },
        })

        // 响应结束后异步蒸馏长期记忆；内部限频（≥12 小时且 ≥5 条新提问），绝大多数请求直接短路
        scheduleAgentMemoryDistillation(user.id)

        const mastraUiStream = toAISdkStream(result, {
            from: "agent",
            version: "v6",
            messageMetadata: ({ part }) => {
                if (part.type === "text-delta") {
                    if (firstTokenAtMs == null) firstTokenAtMs = Date.now()
                    assistantTextAccumulator += part.text
                    chunkCount += 1
                    return undefined
                }
                if (part.type === "finish-step") {
                    finalModelId = part.response.modelId ?? finalModelId
                    return { custom: { modelId: part.response.modelId } }
                }
                if (part.type === "finish") {
                    const usage = normalizeOrEstimateUsage({
                        usage: part.totalUsage,
                        inputTokenEstimate,
                        assistantText: assistantTextAccumulator,
                    })
                    finalUsageMetadata = usage
                    const finishedAt = Date.now()
                    const totalStreamTime = finishedAt - streamStartedAt
                    const firstTokenTime = firstTokenAtMs != null ? firstTokenAtMs - streamStartedAt : undefined
                    const outputTokens = usage.outputTokens ?? 0
                    const tokensPerSecond = totalStreamTime > 0 && outputTokens > 0
                        ? Number((outputTokens / (totalStreamTime / 1000)).toFixed(2))
                        : undefined
                    // assistant-ui 的 message converter 只保留 metadata.custom / steps / timing 等已知字段，
                    // 顶层未知键会被丢弃，所以 usage / 计时数据必须放进 custom 才能落到 thread.messages 上。
                    const subAgentUsage = summarizeSubAgentUsage(subAgentUsageAcc)
                    return {
                        custom: {
                            usage,
                            firstTokenTime,
                            totalStreamTime,
                            totalChunks: chunkCount,
                            ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
                            ...(finalModelId ? { modelId: finalModelId } : {}),
                            ...(subAgentUsage ? { subAgentUsage } : {}),
                        },
                    }
                }
                return undefined
            },
        })

        return createUIMessageStreamResponse({
            stream: createUIMessageStream<UIMessage>({
                originalMessages: input.messages as UIMessage[],
                execute: async ({ writer }) => {
                    const reader = mastraUiStream.getReader()
                    try {
                        while (true) {
                            const { done, value } = await reader.read()
                            if (done) break
                            writer.write(value as UIMessageChunk)
                        }
                    } finally {
                        reader.releaseLock()
                    }
                },
                onEnd: async ({ responseMessage }) => {
                    // 此回调拿到的 responseMessage 是完整的 UIMessage，包含 text + tool-call + reasoning 所有 part，
                    // 用它持久化才能让历史对话刷新后保留工具卡片渲染。
                    const finishedAt = Date.now()
                    const totalStreamTime = finishedAt - streamStartedAt
                    const firstTokenTime = firstTokenAtMs != null ? firstTokenAtMs - streamStartedAt : null
                    const usage = finalUsageMetadata ?? normalizeOrEstimateUsage({
                        usage: undefined,
                        inputTokenEstimate,
                        assistantText: assistantTextAccumulator,
                    })
                    const outputTokens = usage.outputTokens ?? 0
                    const tokensPerSecond = totalStreamTime > 0 && outputTokens > 0
                        ? Number((outputTokens / (totalStreamTime / 1000)).toFixed(2))
                        : null
                    const textContent = extractTextFromUIMessage(responseMessage)
                    const subAgentUsage = summarizeSubAgentUsage(subAgentUsageAcc)
                    await persistAgentMessage({
                        userId: user.id,
                        knowledgeBaseId,
                        threadId: thread.id,
                        role: "assistant",
                        contentText: textContent,
                        content: {
                            parts: responseMessage.parts,
                            text: textContent,
                            usage,
                            modelId: finalModelId ?? config.model,
                            modelName: config.name,
                            firstTokenTime,
                            totalStreamTime,
                            totalChunks: chunkCount,
                            tokensPerSecond,
                            startedAt: streamStartedAt,
                            finishedAt,
                            ...(subAgentUsage ? { subAgentUsage } : {}),
                        },
                    })
                },
            }),
            headers: {
                "X-Petrichor-Agent-Thread-Id": String(thread.id),
                "X-Petrichor-Agent-Run-Id": String(run.id),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

function scheduleAgentMemoryDistillation(userId: number) {
    try {
        after(() => maybeDistillAgentMemory(userId))
    } catch {
        setTimeout(() => {
            void maybeDistillAgentMemory(userId)
        }, 0)
    }
}

// 子 Agent token 用量聚合：单独统计，不并入编排器 usage（后者驱动上下文占用条，须反映真实上下文占用）。
type SubAgentUsageSummary = {
    calls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens?: number
    cachedInputTokens?: number
}

type SubAgentUsageAccumulator = {
    calls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens: number
    cachedInputTokens: number
}

function createSubAgentUsageAccumulator(): SubAgentUsageAccumulator {
    return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }
}

function addSubAgentUsage(acc: SubAgentUsageAccumulator, usage: AssistantUsageSource | undefined) {
    acc.calls += 1
    if (!usage) return
    const inputTokens = numberOrZero(usage.inputTokens)
    const outputTokens = numberOrZero(usage.outputTokens)
    acc.inputTokens += inputTokens
    acc.outputTokens += outputTokens
    acc.totalTokens += numberOrZero(usage.totalTokens) || inputTokens + outputTokens
    acc.reasoningTokens += numberOrZero(usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens)
    acc.cachedInputTokens += numberOrZero(usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens)
}

function summarizeSubAgentUsage(acc: SubAgentUsageAccumulator): SubAgentUsageSummary | undefined {
    if (acc.calls === 0) return undefined
    return {
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        totalTokens: acc.totalTokens,
        ...(acc.reasoningTokens > 0 ? { reasoningTokens: acc.reasoningTokens } : {}),
        ...(acc.cachedInputTokens > 0 ? { cachedInputTokens: acc.cachedInputTokens } : {}),
    }
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function extractLastUserText(messages: unknown[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: unknown; content?: unknown; parts?: unknown }
        if (message?.role !== "user") continue
        const text = extractTextFromMessage(message)
        if (text.trim()) return text.trim()
    }
    return ""
}

function extractTextFromMessage(message: { content?: unknown; parts?: unknown }) {
    if (typeof message.content === "string") return message.content
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : []
    return parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { text?: unknown; type?: unknown }
            return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
        })
        .filter(Boolean)
        .join("\n")
}

type AssistantUsageMetadata = {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    estimated?: boolean
}

type AssistantUsageSource = {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: {
        cacheReadTokens?: number
    }
    outputTokenDetails?: {
        reasoningTokens?: number
    }
}

function normalizeOrEstimateUsage(input: {
    usage: AssistantUsageSource | undefined
    inputTokenEstimate: number
    assistantText: string
}): AssistantUsageMetadata {
    const usage = input.usage
    const result: AssistantUsageMetadata = {}
    if (typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0) {
        result.inputTokens = usage.inputTokens
    }
    if (typeof usage?.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
        result.outputTokens = usage.outputTokens
    }
    if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
        result.totalTokens = usage.totalTokens
    }
    const reasoningTokens = usage?.reasoningTokens ?? usage?.outputTokenDetails?.reasoningTokens
    if (typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens >= 0) {
        result.reasoningTokens = reasoningTokens
    }
    const cachedInputTokens = usage?.cachedInputTokens ?? usage?.inputTokenDetails?.cacheReadTokens
    if (typeof cachedInputTokens === "number" && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0) {
        result.cachedInputTokens = cachedInputTokens
    }
    const hasReal = (result.totalTokens ?? 0) > 0 || (result.inputTokens ?? 0) > 0 || (result.outputTokens ?? 0) > 0
    if (hasReal) {
        if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
            result.totalTokens = result.inputTokens + result.outputTokens
        }
        return result
    }
    const inputTokens = input.inputTokenEstimate
    const outputTokens = estimateTokensFromText(input.assistantText)
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: true,
    }
}

function estimateConversationInputTokens(messages: unknown[]) {
    let total = 0
    for (const message of messages) {
        const text = extractTextFromMessage(message as { content?: unknown; parts?: unknown })
        total += estimateTokensFromText(text)
    }
    return total
}

function extractTextFromUIMessage(message: { parts?: unknown }) {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { type?: unknown; text?: unknown }
            return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
        })
        .filter(Boolean)
        .join("\n")
}

function estimateTokensFromText(text: string) {
    if (!text) return 0
    let tokens = 0
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        if (
            (code >= 0x4e00 && code <= 0x9fff)
            || (code >= 0x3040 && code <= 0x30ff)
            || (code >= 0xac00 && code <= 0xd7af)
        ) {
            tokens += 1
        } else {
            tokens += 0.25
        }
    }
    return Math.max(1, Math.ceil(tokens))
}
