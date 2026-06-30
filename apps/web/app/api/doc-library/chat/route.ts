import type { NextRequest } from "next/server"
import {
    convertToModelMessages,
    createUIMessageStreamResponse,
    isStepCount,
    streamText,
    toUIMessageStream,
    tool,
    type UIMessage,
} from "ai"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { createChatLanguageModel } from "@/server/ai/generation"
import { toErrorResponse } from "@/server/http/response"
import {
    getLibraryOrThrow,
    idSchema,
    listDocumentsForQa,
    readDocumentChunks,
    searchChunks,
} from "@/server/doc-library/library-logic"
import {
    createDocQaArtifact,
    createDocQaRun,
    ensureDocQaThread,
    finishDocQaRun,
    persistDocQaMessage,
    recordDocQaStep,
} from "@/server/doc-library/qa-logic"

export const maxDuration = 300

const chatRequestSchema = z.object({
    libraryId: idSchema.optional().nullable(),
    threadId: idSchema.optional().nullable(),
    messages: z.array(z.unknown()).min(1),
    configId: idSchema.optional().nullable(),
})

const planToolSchema = z.object({
    title: z.string().min(1).default("执行计划"),
    description: z.string().optional(),
    todos: z.array(z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
        description: z.string().optional(),
    })).min(1),
})

const progressToolSchema = z.object({
    title: z.string().min(1).default("执行进度"),
    description: z.string().optional(),
    steps: z.array(z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(["pending", "in-progress", "completed", "failed"]),
    })).min(1),
})

const citationToolSchema = z.object({
    citations: z.array(z.object({
        id: z.string().min(1),
        href: z.string().min(1),
        title: z.string(),
        snippet: z.string().optional(),
        domain: z.string().optional(),
        type: z.enum(["webpage", "document", "article", "api", "code", "other"]).optional(),
    })).min(1),
})

const dataTableToolSchema = z.object({
    title: z.string().optional(),
    columns: z.array(z.object({
        key: z.string(),
        label: z.string(),
        sortable: z.boolean().optional(),
        format: z.unknown().optional(),
    })).min(1),
    data: z.array(z.record(z.string(), z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    ]))).default([]),
})

const artifactToolSchema = z.object({
    artifactType: z.enum(["answer", "table", "timeline", "report", "notes"]).default("answer"),
    title: z.string().min(1).max(200),
    contentMd: z.string().optional(),
    payload: z.unknown().optional(),
})

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const libraryId = input.libraryId ?? null
        if (libraryId != null) {
            await getLibraryOrThrow(user.id, libraryId)
        }

        const thread = await ensureDocQaThread({
            userId: user.id,
            libraryId,
            threadId: input.threadId ?? null,
            title: extractLastUserText(input.messages) || "文档问答",
        })

        const lastUserText = extractLastUserText(input.messages)
        if (lastUserText) {
            await persistDocQaMessage({
                userId: user.id,
                threadId: thread.id,
                role: "user",
                contentText: lastUserText,
                content: input.messages.at(-1),
            })
        }

        const { model, config } = await createChatLanguageModel({
            userId: user.id,
            configId: input.configId ?? null,
            configType: "DOC_QA",
        })
        const run = await createDocQaRun({ userId: user.id, threadId: thread.id, modelName: config.model })

        const tools = buildDocLibraryTools({ userId: user.id, libraryId, threadId: thread.id, runId: run.id })

        const inputTokenEstimate = estimateConversationInputTokens(input.messages)
        let assistantTextAccumulator = ""
        const streamStartedAt = Date.now()
        let firstTokenAtMs: number | null = null
        let chunkCount = 0
        let finalUsageMetadata: AssistantUsageMetadata | null = null
        let finalModelId: string | null = null

        const result = streamText({
            model,
            instructions: buildDocLibrarySystemPrompt(libraryId == null),
            messages: await convertToModelMessages(input.messages as UIMessage[]),
            tools,
            stopWhen: isStepCount(8),
            temperature: 0.2,
            onToolExecutionEnd: async (event) => {
                const isSuccess = event.toolOutput.type === "tool-result"
                await recordDocQaStep({
                    runId: run.id,
                    userId: user.id,
                    stepType: event.toolCall.toolName,
                    title: isSuccess ? `完成工具：${event.toolCall.toolName}` : `工具失败：${event.toolCall.toolName}`,
                    status: isSuccess ? "COMPLETED" : "FAILED",
                    payload: isSuccess ? event.toolOutput.output : { error: String(event.toolOutput.error) },
                })
            },
            onEnd: async () => {
                if (!finalUsageMetadata) {
                    finalUsageMetadata = normalizeOrEstimateUsage({
                        usage: undefined,
                        inputTokenEstimate,
                        assistantText: assistantTextAccumulator,
                    })
                }
                await finishDocQaRun({ runId: run.id, userId: user.id, status: "COMPLETED" })
            },
            onError: async (error) => {
                await finishDocQaRun({
                    runId: run.id,
                    userId: user.id,
                    status: "FAILED",
                    errorMessage: error instanceof Error ? error.message : String(error),
                })
            },
        })

        return createUIMessageStreamResponse({
            stream: toUIMessageStream({
                stream: result.stream,
                tools,
                onEnd: async ({ responseMessage }) => {
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
                    await persistDocQaMessage({
                        userId: user.id,
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
                        },
                    })
                },
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
                        return {
                            custom: {
                                usage,
                                firstTokenTime,
                                totalStreamTime,
                                totalChunks: chunkCount,
                                ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
                                ...(finalModelId ? { modelId: finalModelId } : {}),
                            },
                        }
                    }
                    return undefined
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

function buildDocLibraryTools(context: {
    userId: number
    libraryId: number | null
    threadId: number
    runId: number
}) {
    return {
        show_agent_plan: tool({
            description: "当用户问题需要多步检索、阅读、分析时，先展示清晰执行计划。",
            inputSchema: planToolSchema,
            execute: async (input) => ({
                id: `plan-${Date.now()}`,
                title: input.title,
                description: input.description,
                todos: input.todos,
            }),
        }),
        show_progress: tool({
            description: "展示当前检索、阅读、分析文档的执行进度。",
            inputSchema: progressToolSchema,
            execute: async (input) => ({
                id: `progress-${Date.now()}`,
                title: input.title,
                description: input.description,
                steps: input.steps,
            }),
        }),
        list_documents: tool({
            description: "列出文档库内可检索的文件清单（标题、文件名、类型、页数）。回答前可先用它了解有哪些文档。",
            inputSchema: z.object({}),
            execute: async () => await listDocumentsForQa(context.userId, context.libraryId),
        }),
        search_documents: tool({
            description: "在文档库内按关键词检索文本片段（chunk），返回最相关的片段（含所属文档标题、定位 locator 与片段内容）。这是回答文档内容问题的首选工具。可传 documentId 限定在单个文档内检索。",
            inputSchema: z.object({
                query: z.string().min(1),
                documentId: idSchema.optional().nullable(),
                limit: z.number().int().min(1).max(20).optional(),
            }),
            execute: async ({ query, documentId, limit }) => await searchChunks({
                userId: context.userId,
                libraryId: context.libraryId,
                query,
                documentId: documentId ?? null,
                limit,
            }),
        }),
        read_document: tool({
            description: "顺序读取某个文档的文本片段（用于在 search_documents 命中后获取更完整上下文）。传 documentId，可选 fromIndex 翻页。",
            inputSchema: z.object({
                documentId: idSchema,
                fromIndex: z.number().int().min(0).optional(),
                limit: z.number().int().min(1).max(40).optional(),
            }),
            execute: async ({ documentId, fromIndex, limit }) => await readDocumentChunks({
                userId: context.userId,
                documentId,
                fromIndex,
                limit,
            }),
        }),
        show_citations: tool({
            description: "把最终答案引用到的文档渲染为引用卡片。href 必须使用工具结果里的 href，或按 `/dashboard/doc-library/<libraryId>?documentId=<documentId>` 生成；title 写文档标题，domain 写定位（如 p.3 / Sheet1）。",
            inputSchema: citationToolSchema,
            execute: async ({ citations }) => ({
                id: `citations-${Date.now()}`,
                citations,
                variant: "default" as const,
            }),
        }),
        show_data_table: tool({
            description: "当答案包含结构化对比、清单或矩阵时渲染为表格。",
            inputSchema: dataTableToolSchema,
            execute: async ({ columns, data, title }) => ({
                id: `table-${Date.now()}`,
                title,
                columns,
                data,
                emptyMessage: "暂无数据",
            }),
        }),
        save_answer_artifact: tool({
            description: "保存本轮回答的结构化产物，便于复看。",
            inputSchema: artifactToolSchema,
            execute: async (input) => await createDocQaArtifact({
                userId: context.userId,
                threadId: context.threadId,
                runId: context.runId,
                artifactType: input.artifactType,
                title: input.title,
                contentMd: input.contentMd,
                payload: input.payload,
            }),
        }),
    }
}

function buildDocLibrarySystemPrompt(crossLibrary: boolean) {
    return [
        crossLibrary
            ? "你是 Petrichor 的文档库问答 Agent，本次对话覆盖用户所有文档库里的文件内容。"
            : "你是 Petrichor 的文档库问答 Agent，负责基于当前文档库里的文件内容回答问题。",
        "文档库里存放的是用户上传的原始文件（PDF / Word / Excel / CSV），已被解析为可检索的文本片段。",
        "核心规则：",
        "1. 回答关于文档内容的问题时，第一步先调用 search_documents 按关键词检索相关片段；命中后若上下文不足，再用 read_document 读取该文档更多片段。",
        "2. 需要了解库里有哪些文件时调用 list_documents。",
        "3. 回答必须严格基于检索到的文档内容，不要编造。检索不到就如实说明文档库里没有相关内容。",
        "4. 回答必须给出来源：调用 show_citations 渲染引用；每个引用的 href 必须直接使用 list_documents / search_documents / read_document 返回的 href，或按 `/dashboard/doc-library/<libraryId>?documentId=<documentId>` 生成，禁止使用 `/document/<id>`。title 写文档标题，domain 写定位（如 p.3 / Sheet1），snippet 必须照抄 search_documents / read_document 返回的 snippet 原文（用于在原文中精确高亮，不要改写或截断）。",
        "5. 涉及多步分析时先调用 show_agent_plan，执行中可调用 show_progress。",
        "6. 对比、矩阵、清单类结果优先调用 show_data_table。可复用的最终答案调用 save_answer_artifact。",
        "7. 只使用中文回答。答案要直接、结构清晰。",
    ].join("\n")
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

function normalizeOrEstimateUsage(input: {
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number } | undefined
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
    if (typeof usage?.reasoningTokens === "number" && Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens >= 0) {
        result.reasoningTokens = usage.reasoningTokens
    }
    if (typeof usage?.cachedInputTokens === "number" && Number.isFinite(usage.cachedInputTokens) && usage.cachedInputTokens >= 0) {
        result.cachedInputTokens = usage.cachedInputTokens
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
