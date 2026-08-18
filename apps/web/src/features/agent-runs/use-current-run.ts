"use client"

import { useAgentRunsStore } from "./store"
import type { EvidenceViewModel } from "./types"

/**
 * 正文渲染层（Markdown 组件）拿不到 assistant-ui 的消息上下文，
 * 因此按「最近一个有证据的 Run」解析引用编号。
 * 单条消息内的引用编号本来就只属于该消息对应的 Run，实际不会串号。
 */
export function useCurrentAgentRunEvidence(citationIndex: number | null): EvidenceViewModel | null {
    return useAgentRunsStore((state) => {
        if (citationIndex == null) return null
        const runs = Object.values(state.runs)
        for (let index = runs.length - 1; index >= 0; index -= 1) {
            const match = runs[index].evidence.find((item) => item.citationIndex === citationIndex)
            if (match) return match
        }
        return null
    })
}
