// AI 写作助手支持的操作枚举与参数定义
import { badRequest } from "@/server/http/response"

export const WRITE_ACTIONS = [
    "continue",
    "rewrite",
    "expand",
    "shorten",
    "translate",
    "tone",
] as const

export type WriteAction = typeof WRITE_ACTIONS[number]

export const TRANSLATE_LANGUAGES = [
    "zh",
    "en",
    "ja",
    "ko",
    "fr",
    "es",
] as const

export type TranslateLanguage = typeof TRANSLATE_LANGUAGES[number]

export const TONE_PRESETS = [
    "professional",
    "casual",
    "friendly",
    "concise",
    "academic",
] as const

export type TonePreset = typeof TONE_PRESETS[number]

export const TRANSLATE_LANGUAGE_LABEL: Record<TranslateLanguage, string> = {
    zh: "中文（简体）",
    en: "英文",
    ja: "日文",
    ko: "韩文",
    fr: "法文",
    es: "西班牙文",
}

export const TONE_PRESET_LABEL: Record<TonePreset, string> = {
    professional: "专业",
    casual: "轻松",
    friendly: "友好",
    concise: "简洁",
    academic: "学术",
}

export interface WriteRequestPayload {
    action: WriteAction
    selectedText: string
    contextBefore: string
    contextAfter: string
    language: TranslateLanguage | null
    tone: TonePreset | null
}

const MAX_SELECTED_CHARS = 8000
const MAX_CONTEXT_CHARS = 4000

export function isWriteAction(value: unknown): value is WriteAction {
    return typeof value === "string" && (WRITE_ACTIONS as readonly string[]).includes(value)
}

export function isTranslateLanguage(value: unknown): value is TranslateLanguage {
    return typeof value === "string" && (TRANSLATE_LANGUAGES as readonly string[]).includes(value)
}

export function isTonePreset(value: unknown): value is TonePreset {
    return typeof value === "string" && (TONE_PRESETS as readonly string[]).includes(value)
}

export function validateWriteRequest(raw: unknown): WriteRequestPayload {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const action = value.action
    if (!isWriteAction(action)) {
        throw badRequest("不支持的写作操作")
    }
    const selectedText = clampText(stringValue(value.selectedText), MAX_SELECTED_CHARS)
    const contextBefore = clampText(stringValue(value.contextBefore), MAX_CONTEXT_CHARS, "head")
    const contextAfter = clampText(stringValue(value.contextAfter), MAX_CONTEXT_CHARS, "tail")

    if (action !== "continue" && !selectedText) {
        throw badRequest("请先选中要操作的文本")
    }
    if (action === "continue" && !contextBefore && !selectedText) {
        throw badRequest("没有可续写的上文")
    }

    const language = value.language
    if (action === "translate" && !isTranslateLanguage(language)) {
        throw badRequest("请选择翻译目标语言")
    }
    const tone = value.tone
    if (action === "tone" && !isTonePreset(tone)) {
        throw badRequest("请选择目标语气")
    }

    return {
        action,
        selectedText,
        contextBefore,
        contextAfter,
        language: isTranslateLanguage(language) ? language : null,
        tone: isTonePreset(tone) ? tone : null,
    }
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : ""
}

// 大段上下文按"保留开头/结尾"截断，避免拼接出错位的语义
function clampText(value: string, max: number, keep: "head" | "tail" | "both" = "both") {
    if (value.length <= max) {
        return value
    }
    if (keep === "head") {
        return `${value.slice(0, max)}\n\n[已截断]`
    }
    if (keep === "tail") {
        return `[已截断]\n\n${value.slice(value.length - max)}`
    }
    const half = Math.floor(max / 2)
    return `${value.slice(0, half)}\n\n[中间已截断]\n\n${value.slice(value.length - half)}`
}
