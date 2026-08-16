import { generateText } from "ai"
import { badRequest } from "@/server/http/response"
import { resolveLanguageModel, resolveModelForPurpose, type ResolvedModel } from "@/server/ai/resolution"
import {
    DOCUMENT_VISION_SYSTEM_PROMPT,
    DOCUMENT_VISION_USER_PROMPT,
} from "@/server/ai/vision-prompt"

export interface VisionCompletionResult {
    resolved: ResolvedModel
    markdown: string
    modelName: string
    usage: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
    }
}

/**
 * 调用多模态（VISION）模型，把一张整页图片转写为 Markdown。
 *
 * 走 AI SDK 的多模态 message part，因此 OpenAI 的 image_url、Anthropic 的 base64 image
 * 和 Gemini 的 inlineData 由各自的 provider 包负责编码，这里只管传图。
 * `imageDataUrl` 支持 `data:image/...;base64,...` 或可被模型访问的公网图片 URL。
 */
export async function callVisionCompletion(input: {
    userId: number
    modelRefId?: number | null
    imageDataUrl: string
    systemPrompt?: string | null
    userPrompt?: string | null
    signal?: AbortSignal
}): Promise<VisionCompletionResult> {
    const imageUrl = input.imageDataUrl.trim()
    if (!imageUrl) {
        throw badRequest("缺少待识别的页面图片")
    }

    const { resolved, model } = await resolveLanguageModel({
        userId: input.userId,
        purpose: "VISION",
        modelRefId: input.modelRefId ?? null,
    })

    const result = await generateText({
        model,
        system: input.systemPrompt?.trim() || DOCUMENT_VISION_SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: input.userPrompt?.trim() || DOCUMENT_VISION_USER_PROMPT },
                    { type: "image", image: imageUrl },
                ],
            },
        ],
        ...(resolved.options.maxTokens == null ? {} : { maxOutputTokens: resolved.options.maxTokens }),
        ...(resolved.options.temperature == null ? {} : { temperature: resolved.options.temperature }),
        ...(input.signal ? { abortSignal: input.signal } : {}),
    })

    return {
        resolved,
        markdown: normalizeMarkdown(result.text),
        modelName: resolved.model.modelId,
        usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            totalTokens: result.usage.totalTokens ?? 0,
        },
    }
}

/** 解析 VISION 用途当前绑定的模型（不实例化），供导入任务写回 modelRefId */
export async function resolveVisionModel(userId: number, modelRefId: number | null = null): Promise<ResolvedModel> {
    return resolveModelForPurpose(userId, "VISION", modelRefId)
}

/**
 * 兼容部分模型把多模态回复也包成 content 数组（[{type:"text",text}]）的情况。
 */
export function extractMessageText(content: unknown): string {
    if (typeof content === "string") {
        return content
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part
                if (part && typeof part === "object" && "text" in part) {
                    const text = (part as { text?: unknown }).text
                    return typeof text === "string" ? text : ""
                }
                return ""
            })
            .join("")
    }
    return ""
}

/**
 * 去掉模型偶尔会包裹整体输出的 ```markdown ... ``` 围栏。
 */
export function normalizeMarkdown(raw: string): string {
    const text = raw.trim()
    if (!text) {
        return ""
    }
    const fenceMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
    if (fenceMatch) {
        return fenceMatch[1].trim()
    }
    return text
}
