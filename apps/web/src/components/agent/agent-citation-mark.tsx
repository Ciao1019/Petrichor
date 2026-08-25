"use client"

import type { ComponentProps } from "react"
import { useCurrentAgentRunEvidence } from "@/features/agent-runs/use-current-run"

/**
 * 正文内的引用标记解析器（§162.17/§162.18）。
 *
 * remarkCitations 把 [n] 转成 <citation data-citation-index="n">，
 * Agent Run 的真实引用统一放到答案末尾的“来源”条，因此正文不再渲染角标。
 * 找不到对应 Evidence 时保留原文，避免误删普通内容里的数字方括号。
 */
export function AgentCitationMark(props: ComponentProps<"span"> & { "data-citation-index"?: string }) {
    const rawIndex = props["data-citation-index"]
    const index = Number(rawIndex)
    const evidence = useCurrentAgentRunEvidence(Number.isInteger(index) ? index : null)

    if (!evidence) {
        return <span className="align-super text-[10px] text-muted-foreground">[{rawIndex}]</span>
    }
    return null
}
