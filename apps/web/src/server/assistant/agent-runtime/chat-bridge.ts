import type { UIMessageChunk } from "ai"
import type { AgentStreamEvent } from "./events"
import { describeStopReasonForUser } from "./stop-policy"
import type { AgentStopReason } from "./types"

/**
 * Agent 事件 → 聊天流的桥接（§78/§108/§162.2）。
 *
 * 兼容策略：最终答案仍走标准 text-* chunk，旧前端不改也能正常显示；
 * Agent 执行状态作为新增的 data-agent-event part 下发，前端 reducer 消费。
 */

export const AGENT_EVENT_PART_TYPE = "data-agent-event"
export const AGENT_ANSWER_TEXT_ID = "agent-answer"

export type ChatStreamWriter = {
    write: (chunk: UIMessageChunk) => void
}

/**
 * 事件写入器：
 * - final_answer_delta 只走结构化事件，供 AgentRun UI 实时渲染；
 * - final_answer_completed 才写入唯一一段标准 text，保证持久消息与旧前端兼容；
 * - 其余事件原样作为结构化 part 下发（transient=false，便于刷新前的本地回放）；
 * - agent_stopped 附带面向用户的安全文案。
 */
export function createAgentEventWriter(writer: ChatStreamWriter) {
    let answerBuffer = ""
    let answerLength = 0
    let finalTextWritten = false

    const writeFinalText = (text: string) => {
        if (finalTextWritten || !text) return
        finalTextWritten = true
        writer.write({ type: "text-start", id: AGENT_ANSWER_TEXT_ID })
        writer.write({ type: "text-delta", id: AGENT_ANSWER_TEXT_ID, delta: text })
        writer.write({ type: "text-end", id: AGENT_ANSWER_TEXT_ID })
    }

    return {
        onEvent(event: AgentStreamEvent): void {
            switch (event.type) {
                case "final_answer_started": {
                    // 服务端只把最后一段当作最终答案：这里跟着重置兜底缓冲。
                    // 标准 text 不能撤回，所以在最终完成前绝不把推测性的过程话
                    // 写进聊天消息；实时显示由前端 reducer 按段维护。
                    answerBuffer = ""
                    answerLength = 0
                    break
                }
                case "final_answer_delta": {
                    const delta = (event.payload as { delta: string }).delta
                    answerBuffer += delta
                    answerLength += delta.length
                    break
                }
                case "final_answer_completed": {
                    const completed = (event.payload as { text?: unknown }).text
                    const text = typeof completed === "string" ? completed : answerBuffer
                    answerBuffer = text
                    answerLength = text.length
                    writeFinalText(text)
                    break
                }
                case "agent_completed":
                case "agent_cancelled":
                case "agent_error": {
                    break
                }
                case "agent_stopped": {
                    break
                }
                default:
                    break
            }

            writer.write({
                type: AGENT_EVENT_PART_TYPE,
                // 高频 delta 复用同一个 data part：前端仍逐次收到更新，但持久消息只留
                // 最后一次 delta + final_answer_completed 全文，避免长答案产生数百个 parts。
                id: event.type === "final_answer_delta"
                    ? `${event.runId}:answer-delta`
                    : `${event.runId}:${event.sequence}`,
                data: toPublicEventPayload(event),
            } as UIMessageChunk)
        },
        finalize(): void {
            // 正常 Runtime 必定发 final_answer_completed；异常路径不能把未确认的过程话持久化。
        },
        get answerLength(): number {
            return answerLength
        },
    }
}

/** 停止原因转成安全文案，内部策略名只留在 Debug 通道（§162.26） */
export function toPublicEventPayload(event: AgentStreamEvent): AgentStreamEvent {
    if (event.type !== "agent_stopped") return event
    const payload = event.payload as { stopReason: AgentStopReason; message: string }
    return {
        ...event,
        payload: {
            ...payload,
            message: describeStopReasonForUser(payload.stopReason) ?? payload.message,
        },
    } as AgentStreamEvent
}
