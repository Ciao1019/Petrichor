import { and, asc, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { aiModelConfigs, type AiModelConfigRecord } from "@/server/db/schema"
import { decodeApiKey, type AiProtocol } from "@/server/ai/config-logic"
import { badRequest, notFound } from "@/server/http/response"
import {
    DOCUMENT_VISION_SYSTEM_PROMPT,
    DOCUMENT_VISION_USER_PROMPT,
} from "@/server/ai/vision-prompt"

const SUPPORTED_VISION_PROTOCOLS: AiProtocol[] = ["OPENAI", "DEEPSEEK", "OPENAI_COMPAT", "SILICONFLOW"]

export interface VisionCompletionResult {
    config: AiModelConfigRecord
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
 * 复用 OpenAI 兼容 `/chat/completions`，user 消息使用多模态 content 数组
 * （text + image_url）。imageDataUrl 应为 `data:image/...;base64,...` 形式，
 * 也可传入可被模型访问的公网图片 URL。
 */
export async function callVisionCompletion(input: {
    userId: number
    configId?: number | null
    imageDataUrl: string
    systemPrompt?: string | null
    userPrompt?: string | null
}): Promise<VisionCompletionResult> {
    const imageUrl = input.imageDataUrl.trim()
    if (!imageUrl) {
        throw badRequest("缺少待识别的页面图片")
    }

    const config = await resolveVisionConfig(input.userId, input.configId ?? null)
    const apiKey = decodeApiKey(config.apiKeyEnc)
    if (!apiKey) {
        throw badRequest("VISION 配置缺少 API Key")
    }
    if (config.protocol === "GEMINI") {
        throw badRequest("GEMINI 协议已禁用，请使用 OPENAI / DEEPSEEK / OPENAI_COMPAT / SILICONFLOW")
    }
    if (!SUPPORTED_VISION_PROTOCOLS.includes(config.protocol as AiProtocol)) {
        throw badRequest("协议类型不能为空")
    }

    const baseUrl = config.baseUrl?.trim().replace(/\/+$/, "")
    if (!baseUrl) {
        throw badRequest("BaseUrl 不能为空")
    }
    if (!config.model.trim()) {
        throw badRequest("模型名称不能为空")
    }

    const requestBody = {
        model: config.model,
        stream: false,
        messages: [
            {
                role: "system",
                content: input.systemPrompt?.trim() || DOCUMENT_VISION_SYSTEM_PROMPT,
            },
            {
                role: "user",
                content: [
                    { type: "text", text: input.userPrompt?.trim() || DOCUMENT_VISION_USER_PROMPT },
                    { type: "image_url", image_url: { url: imageUrl } },
                ],
            },
        ],
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
        const detail = await safeReadErrorText(response)
        throw badRequest(`调用多模态接口失败：HTTP ${response.status}${detail ? `（${detail}）` : ""}`)
    }

    const data = await response.json() as {
        model?: string
        choices?: Array<{ message?: { content?: unknown } }>
        usage?: {
            completion_tokens?: number
            prompt_tokens?: number
            total_tokens?: number
        }
    }

    return {
        config,
        markdown: normalizeMarkdown(extractMessageText(data.choices?.[0]?.message?.content)),
        modelName: data.model ?? config.model,
        usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
            totalTokens: data.usage?.total_tokens ?? 0,
        },
    }
}

export async function resolveVisionConfig(userId: number, configId: number | null) {
    if (configId != null) {
        const [config] = await getDb()
            .select()
            .from(aiModelConfigs)
            .where(and(eq(aiModelConfigs.id, configId), eq(aiModelConfigs.userId, userId)))
            .limit(1)
        if (!config) {
            throw notFound("VISION 配置不存在")
        }
        if (config.configType !== "VISION") {
            throw badRequest("配置类型不是 VISION")
        }
        if (!config.enabled) {
            throw badRequest("VISION 配置未启用")
        }
        return config
    }

    const [config] = await getDb()
        .select()
        .from(aiModelConfigs)
        .where(and(
            eq(aiModelConfigs.userId, userId),
            eq(aiModelConfigs.configType, "VISION"),
            eq(aiModelConfigs.isDefault, true),
            eq(aiModelConfigs.enabled, true),
        ))
        .orderBy(asc(aiModelConfigs.id))
        .limit(1)

    if (!config) {
        throw badRequest("未找到可用的默认配置：VISION（请先在「模型配置 → 多模态」中新增并设为默认）")
    }
    return config
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

async function safeReadErrorText(response: Response): Promise<string> {
    try {
        const text = (await response.text()).trim()
        return text.slice(0, 200)
    } catch {
        return ""
    }
}
