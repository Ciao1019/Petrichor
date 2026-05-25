// 编辑器 AI 写作助手共享类型

export const WRITE_ACTIONS = [
  "continue",
  "rewrite",
  "expand",
  "shorten",
  "translate",
  "tone",
] as const

export type WriteAction = typeof WRITE_ACTIONS[number]

export const TRANSLATE_LANGUAGES = ["zh", "en", "ja", "ko", "fr", "es"] as const
export type TranslateLanguage = typeof TRANSLATE_LANGUAGES[number]

export const TONE_PRESETS = [
  "professional",
  "casual",
  "friendly",
  "concise",
  "academic",
] as const
export type TonePreset = typeof TONE_PRESETS[number]

export const ACTION_LABEL: Record<WriteAction, string> = {
  continue: "续写",
  rewrite: "改写",
  expand: "扩展",
  shorten: "精简",
  translate: "翻译",
  tone: "调整语气",
}

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

export interface AiAssistantContext {
  selectedText: string
  contextBefore: string
  contextAfter: string
  hasSelection: boolean
}

export interface AiAssistantRequest extends AiAssistantContext {
  action: WriteAction
  language: TranslateLanguage | null
  tone: TonePreset | null
}
