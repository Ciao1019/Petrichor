import { describe, expect, it } from "vitest"
import { createAgentEventWriter } from "./chat-bridge"
import type { AgentStreamEvent } from "./events"

function event(
    sequence: number,
    type: AgentStreamEvent["type"],
    payload: Record<string, unknown> = {},
): AgentStreamEvent {
    return {
        runId: "run-1",
        sequence,
        type,
        timestamp: sequence,
        payload,
    } as AgentStreamEvent
}

describe("Agent chat stream bridge", () => {
    it("换段时不固化过程话，完成后只写一段标准答案", () => {
        const chunks: Array<Record<string, unknown>> = []
        const bridge = createAgentEventWriter({ write: (chunk) => chunks.push(chunk as never) })

        bridge.onEvent(event(1, "final_answer_started"))
        bridge.onEvent(event(2, "final_answer_delta", { delta: "我先查一下。" }))
        bridge.onEvent(event(3, "final_answer_started"))
        bridge.onEvent(event(4, "final_answer_delta", { delta: "最终" }))
        bridge.onEvent(event(5, "final_answer_delta", { delta: "答案" }))

        expect(chunks.filter((chunk) => String(chunk.type).startsWith("text-"))).toHaveLength(0)

        bridge.onEvent(event(6, "final_answer_completed", { text: "最终答案" }))
        bridge.onEvent(event(7, "agent_completed", { status: "completed", metrics: {} }))
        bridge.finalize()

        const textChunks = chunks.filter((chunk) => String(chunk.type).startsWith("text-"))
        expect(textChunks.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta", "text-end"])
        expect(textChunks.find((chunk) => chunk.type === "text-delta")?.delta).toBe("最终答案")
        expect(JSON.stringify(textChunks)).not.toContain("我先查一下")
    })

    it("Wiki 标注词典只参与当前流式渲染，不写入持久消息", () => {
        const chunks: Array<Record<string, unknown>> = []
        const bridge = createAgentEventWriter({ write: (chunk) => chunks.push(chunk as never) })

        bridge.onEvent(event(1, "wiki_mention_targets", {
            targets: [{
                pageKey: "entity-mole",
                title: "小鼹鼠",
                aliases: ["Mole"],
                kind: "entity",
                citationIndex: null,
            }],
        }))

        expect(chunks).toContainEqual(expect.objectContaining({
            type: "data-agent-event",
            transient: true,
        }))
    })
})
