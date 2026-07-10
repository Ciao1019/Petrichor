import type { NextRequest } from "next/server"
import {
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    type UIMessage,
    type UIMessageChunk,
} from "ai"
import { toAISdkStream } from "@mastra/ai-sdk"
import { Agent } from "@mastra/core/agent"
import { PromptInjectionDetector, TokenLimiterProcessor } from "@mastra/core/processors"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { createChatLanguageModel } from "@/server/ai/generation"
import { HttpError, toErrorResponse } from "@/server/http/response"
import type { AgentDomainId, AssistantToolContext } from "./domain-types"
import { assertAssistantFocusOwnership } from "./focus-guard"
import { routeAssistantIntent } from "./intent-router"
import "./tools"
import { loadMastraToolsForDomains } from "./tool-registry"
import { createToolResilienceController, ToolResilienceError } from "./tool-resilience"
import {
    assistantFocusSchema,
    assistantIdSchema,
    createAssistantRun,
    ensureAssistantThread,
    finishAssistantRun,
    listRecentToolNames,
    persistAssistantMessage,
    recordAssistantStep,
} from "./thread-logic"

const chatRequestSchema = z.object({
    threadId: assistantIdSchema.optional().nullable(),
    messages: z.array(z.unknown()).min(1),
    configId: assistantIdSchema.optional().nullable(),
    focus: assistantFocusSchema.optional().nullable(),
})

const MAX_CONTEXT_TOKENS = 100_000

type AgentModelConfig = ConstructorParameters<typeof Agent>[0]["model"]
type ProcessorModel = ConstructorParameters<typeof PromptInjectionDetector>[0]["model"]

export function buildAssistantSystemPrompt(domains: AgentDomainId[]): string {
    const activeDomains = new Set(domains)
    const guidance: string[] = []

    if (activeDomains.has("system")) {
        guidance.push("系统元信息问题使用 list_system_overview 获取真实计数与模型状态。多步任务用 show_progress 或 upsert_plan 更新进度（界面在侧栏展示，不在消息里重复叙述步骤）；每完成一步应再次调用同一 id 刷新状态。需要保存可复用结果时才使用 save_answer_artifact。")
    }
    if (activeDomains.has("knowledge")) {
        guidance.push("知识库问题先调用 search_knowledge 定位内容，再用 read_knowledge_node 深读命中节点；优先沿用 focus 默认范围，必要时才显式跨库检索。")
    }
    if (activeDomains.has("doc_library")) {
        guidance.push("文档库问题先调用 search_documents 获取带定位的片段；上下文不足时调用 read_document，并用 fromIndex 继续翻页。")
    }
    if (activeDomains.has("system") && (activeDomains.has("knowledge") || activeDomains.has("doc_library"))) {
        guidance.push("最终答案必须基于工具返回内容，并调用 show_citations 给出引用；href、title、domain、snippet 必须直接来自检索/读取结果，不得改写或编造。")
    }

    return [
        "你是 Petrichor 的站内助手，以对话方式帮助已登录用户查看和操作系统。",
        `本轮路由域：${domains.join(", ")}。只调用本轮实际提供的工具；没有对应写入或管理工具时，不要假装已经执行。`,
        ...guidance,
        "站内事实必须以工具结果为准；检索不到就如实说明，不要编造数据、来源、链接或原文片段。",
        "若某工具失败或超时，改用其他可用工具或降级说明，不要反复调用同一已失败工具。",
        "只使用中文回答，直接、结构清晰。",
    ].join("\n")
}

export async function assistantChat(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const focus = input.focus ?? null

        // 契约 4.1：焦点实体归属校验先于建 thread，403 时不留脏数据
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
        const route = await routeAssistantIntent({ userText: lastUserText, focus, recentToolNames })
        const run = await createAssistantRun({
            threadId: thread.id,
            modelConfigId: config.id,
            intentDomains: route.domains,
        })

        const toolContext: AssistantToolContext = {
            userId: user.id,
            threadId: thread.id,
            runId: run.id,
            focus,
        }
        // 每轮只装载意图路由命中的域（契约 4.1：禁止一次挂载全站 tools）
        const resilience = createToolResilienceController()
        const tools = loadMastraToolsForDomains(route.domains, toolContext, resilience)
        const activeToolNames = Object.keys(tools)

        const agent = new Agent({
            id: "petrichor-assistant",
            name: "Petrichor Assistant",
            description: "In-site universal assistant for system overview, knowledge bases, and document libraries.",
            model: model as unknown as AgentModelConfig,
            instructions: buildAssistantSystemPrompt(route.domains),
            tools,
            // Vitest mock 模型未实现 doGenerate；注入检测会额外 generate，测试环境只保留 token 裁剪
            inputProcessors: process.env.VITEST
                ? [new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" })]
                : [
                    new PromptInjectionDetector({
                        model: model as unknown as ProcessorModel,
                        strategy: "block",
                        threshold: 0.85,
                        detectionTypes: ["injection", "jailbreak", "system-override"],
                        lastMessageOnly: true,
                    }),
                    new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" }),
                ],
        })

        let runFinalized = false
        const finishRunOnce = async (status: "COMPLETED" | "FAILED", errorCode?: string) => {
            if (runFinalized) return
            runFinalized = true
            await finishAssistantRun({ runId: run.id, status, errorCode })
        }

        let stepIndex = 0
        const modelMessages = await convertToModelMessages(input.messages as UIMessage[])
        const result = await agent.stream(modelMessages as never, {
            maxSteps: 8,
            modelSettings: { temperature: 0.2 },
            activeTools: activeToolNames,
            abortSignal: request.signal,
            hooks: {
                afterToolCall: async ({ toolName, output, error }) => {
                    const meta = resilience.consumeMeta(toolName)
                    const isSuccess = error == null && meta?.errorCode == null
                    const errorCode = isSuccess
                        ? null
                        : meta?.errorCode
                            ?? (error instanceof ToolResilienceError ? error.code : "tool_error")
                    await recordAssistantStep({
                        runId: run.id,
                        stepIndex: stepIndex++,
                        toolName,
                        input: {},
                        output: isSuccess
                            ? output
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
                    } catch {
                        await finishRunOnce("FAILED", "stream_aborted")
                        throw new Error("assistant stream aborted")
                    } finally {
                        reader.releaseLock()
                    }
                },
                onEnd: async ({ responseMessage }) => {
                    await persistAssistantMessage({
                        userId: user.id,
                        threadId: thread.id,
                        role: "assistant",
                        content: { parts: responseMessage.parts },
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

// 契约 4.1：模型未配置 → 409 model_not_configured。
// createChatLanguageModel 对配置缺失/不可用抛 400/404，在 assistant 入口统一转译为 409，不改动共享层语义。
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
