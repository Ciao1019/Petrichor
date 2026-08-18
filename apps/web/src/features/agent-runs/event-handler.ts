import { isAgentStreamEvent } from "./types"
import { useAgentRunsStore } from "./store"

/**
 * 流事件入口（§162.5）。
 *
 * 聊天流里的 data-agent-event part 全部走这里进 Store。
 * 组件不解析事件、不猜状态，只读 ViewModel。
 */
export function handleAgentStreamPart(data: unknown): boolean {
    if (!isAgentStreamEvent(data)) return false
    useAgentRunsStore.getState().appendEvent(data)
    return true
}

/** 从助手消息里找出关联的 runId（§162.28） */
export function extractRunIdFromParts(parts: unknown): string | null {
    if (!Array.isArray(parts)) return null
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index] as { type?: unknown; name?: unknown; data?: unknown }
        if (part?.type !== "data") continue
        const data = part.data
        if (isAgentStreamEvent(data)) return data.runId
    }
    return null
}
