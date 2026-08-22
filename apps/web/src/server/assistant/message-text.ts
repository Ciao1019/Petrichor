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
