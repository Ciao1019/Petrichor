// 按 action 构造 system + user prompt
import {
    TONE_PRESET_LABEL,
    TRANSLATE_LANGUAGE_LABEL,
    type WriteRequestPayload,
} from "./actions"

const BASE_RULES = [
    "你是 Petrichor 编辑器内置的中文写作助手。",
    "硬性规则：",
    "- 直接输出可粘贴回编辑器的纯文本结果，不要加任何解释、前缀、引号、Markdown 代码块、章节标题。",
    "- 不要重复用户原文，除非操作明确要求保留原文。",
    "- 保持与原文一致的 Markdown 格式（段落、列表、链接、加粗等），不要新增章节标题。",
    "- 用与用户原文一致的语言风格，除非操作要求改变语言或语气。",
].join("\n")

export function buildWriteSystemPrompt(action: WriteRequestPayload["action"]) {
    switch (action) {
        case "continue":
            return [
                BASE_RULES,
                "本次任务：续写。",
                "- 基于「上文」自然延续，输出 1-3 段新内容，约 80-300 字。",
                "- 不要重复上文中已经表达的观点，从上文结束之处自然延伸。",
                "- 不要以「接下来」「综上所述」等模板化短语开头。",
            ].join("\n")
        case "rewrite":
            return [
                BASE_RULES,
                "本次任务：改写选中文本。",
                "- 保留原意与关键信息，改换表达方式与措辞。",
                "- 输出长度与原文相近，不要刻意拉长或精简。",
            ].join("\n")
        case "expand":
            return [
                BASE_RULES,
                "本次任务：扩展选中文本。",
                "- 在原意基础上补充背景、细节、例子或论证，使内容更丰满。",
                "- 输出长度约为原文 1.5-2.5 倍，保持自然过渡，避免堆砌。",
            ].join("\n")
        case "shorten":
            return [
                BASE_RULES,
                "本次任务：精简选中文本。",
                "- 保留核心信息，剔除冗余修饰、重复说法与无关细节。",
                "- 输出长度约为原文 40-60%，保持表达通顺。",
            ].join("\n")
        case "translate":
            return [
                BASE_RULES,
                "本次任务：翻译选中文本。",
                "- 译文要符合目标语言的自然表达习惯，不要直译。",
                "- 保留原文 Markdown 标记与变量名／代码片段不变。",
                "- 专有名词如无通用译法，可保留原文。",
            ].join("\n")
        case "tone":
            return [
                BASE_RULES,
                "本次任务：调整选中文本的语气。",
                "- 保留原意与事实，只改变语气与措辞。",
                "- 输出长度与原文相近。",
            ].join("\n")
    }
}

export function buildWriteUserMessage(payload: WriteRequestPayload) {
    const sections: string[] = []
    switch (payload.action) {
        case "continue": {
            sections.push("=== 上文 ===")
            sections.push(payload.contextBefore || "（无）")
            if (payload.selectedText) {
                sections.push("")
                sections.push("=== 用户选中的引导文字（请基于此自然续写） ===")
                sections.push(payload.selectedText)
            }
            if (payload.contextAfter) {
                sections.push("")
                sections.push("=== 下文（仅供参考，避免与之冲突，但不要重复其内容） ===")
                sections.push(payload.contextAfter)
            }
            sections.push("")
            sections.push("请输出续写内容。")
            break
        }
        case "rewrite":
        case "expand":
        case "shorten": {
            if (payload.contextBefore) {
                sections.push("=== 上文（仅供理解语境） ===")
                sections.push(payload.contextBefore)
                sections.push("")
            }
            sections.push("=== 选中文本 ===")
            sections.push(payload.selectedText)
            if (payload.contextAfter) {
                sections.push("")
                sections.push("=== 下文（仅供理解语境） ===")
                sections.push(payload.contextAfter)
            }
            sections.push("")
            sections.push(`请输出${actionLabel(payload.action)}后的结果。`)
            break
        }
        case "translate": {
            if (!payload.language) {
                throw new Error("missing language")
            }
            sections.push(`=== 翻译目标语言：${TRANSLATE_LANGUAGE_LABEL[payload.language]} ===`)
            sections.push("")
            sections.push("=== 选中文本 ===")
            sections.push(payload.selectedText)
            sections.push("")
            sections.push("请输出译文。")
            break
        }
        case "tone": {
            if (!payload.tone) {
                throw new Error("missing tone")
            }
            sections.push(`=== 目标语气：${TONE_PRESET_LABEL[payload.tone]} ===`)
            sections.push("")
            sections.push("=== 选中文本 ===")
            sections.push(payload.selectedText)
            sections.push("")
            sections.push("请输出调整后的文本。")
            break
        }
    }
    return sections.join("\n")
}

function actionLabel(action: WriteRequestPayload["action"]) {
    switch (action) {
        case "rewrite": return "改写"
        case "expand": return "扩展"
        case "shorten": return "精简"
        default: return action
    }
}
