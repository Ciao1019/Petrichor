/**
 * 消息文本抽取纯函数（无 DB / 无模块副作用）。
 *
 * 独立成文件的原因：后台 chat-handler 顶部有 `import "./agent-runtime/tools"`
 * 这类注册副作用，公开问答等轻量入口不能为了一个纯函数把整条链路拉进模块图。
 */

/** 消息明文抽取：压缩与召回共用，避免双份规则漂移。 */
export function extractMessagePlainText(message: unknown): string {
    if (!message || typeof message !== "object") return ""
    const record = message as { role?: unknown; content?: unknown; parts?: unknown }
    const role = typeof record.role === "string" ? record.role : "unknown"
    if (typeof record.content === "string" && record.content.trim()) {
        return `${role}: ${record.content.trim()}`
    }
    const parts = Array.isArray(record.parts)
        ? record.parts
        : Array.isArray(record.content)
            ? record.content
            : []
    const text = parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { type?: unknown; text?: unknown }
            if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text
            return ""
        })
        .filter(Boolean)
        .join("\n")
        .trim()
    return text ? `${role}: ${text}` : ""
}

/** 取最后一条 user 消息的纯文本（作为本轮 goal / 会话标题候选）。 */
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

export function isUserRoleMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") return false
    return (message as { role?: unknown }).role === "user"
}
