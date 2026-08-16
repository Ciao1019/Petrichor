/**
 * 语言模型调用入口。
 *
 * 所有请求都经由 AI SDK 的 provider 实例发出，不再手写 `/chat/completions` fetch，
 * 因此 Anthropic 的 /v1/messages、Gemini 的原生接口、Bedrock 的 SigV4 都能正常工作。
 */

import { generateText } from "ai"
import type { LanguageModel } from "ai"
import {
    resolveLanguageModel,
    resolveModelForPurpose,
    type ResolvedModel,
} from "@/server/ai/resolution"
import { guessContextWindow } from "@/server/ai/provider-catalog"
import type { AiPurpose } from "@/server/ai/config-logic"

export interface ChatCompletionMessage {
    role: "system" | "user" | "assistant"
    content: string
}

export interface ChatCompletionResult {
    resolved: ResolvedModel
    answer: string
    modelName: string
    reasoning: string | null
    usage: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
    }
}

/**
 * 一次性文本生成（非流式）。用于摘要、Wiki 编译、上下文压缩这类后台任务。
 */
export async function callChatCompletion(input: {
    userId: number
    purpose?: AiPurpose
    modelRefId?: number | null
    systemPrompt?: string | null
    message?: string
    messages?: ChatCompletionMessage[]
    signal?: AbortSignal
}): Promise<ChatCompletionResult> {
    const purpose = input.purpose ?? "CHAT"
    const { resolved, model } = await resolveLanguageModel({
        userId: input.userId,
        purpose,
        modelRefId: input.modelRefId ?? null,
    })

    const { system, messages } = buildPrompt(input)
    const result = await generateText({
        model,
        ...(system ? { system } : {}),
        messages,
        ...(resolved.options.maxTokens == null ? {} : { maxOutputTokens: resolved.options.maxTokens }),
        ...(resolved.options.temperature == null ? {} : { temperature: resolved.options.temperature }),
        ...(input.signal ? { abortSignal: input.signal } : {}),
    })

    return {
        resolved,
        answer: result.text.trim(),
        modelName: resolved.model.modelId,
        reasoning: extractReasoningText(result.reasoning),
        usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            totalTokens: result.usage.totalTokens ?? 0,
        },
    }
}

/**
 * 拿到裸的 LanguageModel 实例，交给 Mastra Agent 或 AI SDK 流式接口使用。
 */
export async function createChatLanguageModel(input: {
    userId: number
    purpose?: AiPurpose
    modelRefId?: number | null
}): Promise<{ resolved: ResolvedModel; model: LanguageModel }> {
    return resolveLanguageModel({
        userId: input.userId,
        purpose: input.purpose ?? "CHAT",
        modelRefId: input.modelRefId ?? null,
    })
}

/** 只解析不实例化，用于只需要模型元信息（名称、上下文窗口）的场景 */
export async function resolveChatModel(input: {
    userId: number
    purpose?: AiPurpose
    modelRefId?: number | null
}): Promise<ResolvedModel> {
    return resolveModelForPurpose(input.userId, input.purpose ?? "CHAT", input.modelRefId ?? null)
}

/**
 * 模型上下文窗口：优先用模型记录上存的值（拉取列表时写入或用户手填），
 * 没有就按模型名的家族特征推断。
 */
export function resolveModelContextWindow(input: {
    model: string
    contextWindow?: number | null
}): number {
    if (input.contextWindow != null && input.contextWindow > 0) {
        return input.contextWindow
    }
    return guessContextWindow(input.model)
}

function buildPrompt(input: {
    systemPrompt?: string | null
    message?: string
    messages?: ChatCompletionMessage[]
}): { system: string | null; messages: { role: "user" | "assistant"; content: string }[] } {
    if (input.messages?.length) {
        // AI SDK 把 system 单独传，需要从 messages 里剥出来
        const system = input.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n")
            .trim()
        const rest = input.messages
            .filter((message): message is ChatCompletionMessage & { role: "user" | "assistant" } =>
                message.role !== "system")
            .map((message) => ({ role: message.role, content: message.content }))
        return {
            system: system || input.systemPrompt?.trim() || null,
            messages: rest.length > 0 ? rest : [{ role: "user", content: "" }],
        }
    }

    return {
        system: input.systemPrompt?.trim() || null,
        messages: [{ role: "user", content: input.message ?? "" }],
    }
}

/** AI SDK v7 的 reasoning 是 ReasoningPart[]，压平成纯文本 */
function extractReasoningText(reasoning: unknown): string | null {
    if (typeof reasoning === "string") {
        return reasoning.trim() || null
    }
    if (!Array.isArray(reasoning)) {
        return null
    }
    const text = reasoning
        .map((part) => {
            if (typeof part === "string") return part
            if (part && typeof part === "object" && "text" in part) {
                const value = (part as { text?: unknown }).text
                return typeof value === "string" ? value : ""
            }
            return ""
        })
        .join("")
        .trim()
    return text || null
}
