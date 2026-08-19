"use client"

import type { AgentRunViewModel, AgentStreamEvent } from "./types"

/**
 * 流式节奏诊断（默认关闭）。
 *
 * 打开：localStorage.setItem("petrichor.debug.stream", "1")，刷新后再问一次。
 * 关闭：localStorage.removeItem("petrichor.debug.stream")
 *
 * 它回答的是一个具体问题：屏幕上"一下冒出很多字"时，那些字到底是什么时候
 * 到达前端的。如果 delta 本身就是均匀小块，问题在渲染层；如果尾部出现一次
 * 巨大的 delta 或一次替换，问题在上游。
 */

type Sample = { at: number; chars: number }

const traces = new Map<string, { startedAt: number; samples: Sample[]; replaced: boolean }>()

function enabled(): boolean {
    if (typeof window === "undefined") return false
    try {
        return window.localStorage.getItem("petrichor.debug.stream") === "1"
    } catch {
        return false
    }
}

function median(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

export function traceAnswerStream(
    prev: AgentRunViewModel | null,
    next: AgentRunViewModel,
    event: AgentStreamEvent,
): void {
    if (!enabled()) return
    const now = performance.now()

    switch (event.type) {
        case "final_answer_started": {
            if (!traces.has(event.runId)) {
                traces.set(event.runId, { startedAt: now, samples: [], replaced: false })
            }
            return
        }
        case "final_answer_delta": {
            const trace = traces.get(event.runId)
                ?? { startedAt: now, samples: [], replaced: false }
            traces.set(event.runId, trace)
            trace.samples.push({ at: now, chars: next.answer.length - (prev?.answer.length ?? 0) })
            return
        }
        case "final_answer_completed": {
            const trace = traces.get(event.runId)
            if (trace) trace.replaced = next.answer !== prev?.answer
            return
        }
        case "agent_completed":
        case "agent_stopped":
        case "agent_cancelled":
        case "agent_error": {
            const trace = traces.get(event.runId)
            if (!trace) return
            traces.delete(event.runId)
            const { samples } = trace
            if (samples.length === 0) return

            const totalMs = samples[samples.length - 1].at - trace.startedAt
            const chars = samples.reduce((sum, s) => sum + s.chars, 0)
            const sizes = samples.map((s) => s.chars)
            let gapMax = 0
            let gapAtIndex = 0
            for (let i = 1; i < samples.length; i += 1) {
                const gap = samples[i].at - samples[i - 1].at
                if (gap > gapMax) {
                    gapMax = gap
                    gapAtIndex = i
                }
            }
            const biggest = Math.max(...sizes)

            console.info(
                [
                    `[stream] ${event.runId}`,
                    `  时长 ${(totalMs / 1000).toFixed(1)}s  共 ${chars} 字  平均 ${Math.round(chars / (totalMs / 1000))} 字/秒`,
                    `  delta ${samples.length} 次  最大单次 ${biggest} 字  中位 ${median(sizes)} 字`,
                    `  最大间隔 ${Math.round(gapMax)}ms（第 ${gapAtIndex} 次之后）`,
                    `  收尾是否整段替换：${trace.replaced ? "是（会绕过下游平滑）" : "否"}`,
                ].join("\n"),
            )
            return
        }
        default:
            return
    }
}
