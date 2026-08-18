"use client"

import type { ComponentProps } from "react"
import { useCurrentAgentRunEvidence } from "@/features/agent-runs/use-current-run"
import { AgentCitation } from "./agent-evidence"

/**
 * 正文内的引用角标渲染器（§162.17/§162.18）。
 *
 * remarkCitations 把 [n] 转成 <citation data-citation-index="n">，
 * 这里按编号找到对应 Evidence；找不到就退回纯文本，不制造死链接。
 */
export function AgentCitationMark(props: ComponentProps<"span"> & { "data-citation-index"?: string }) {
    const rawIndex = props["data-citation-index"]
    const index = Number(rawIndex)
    const evidence = useCurrentAgentRunEvidence(Number.isInteger(index) ? index : null)

    if (!evidence) {
        return <span className="align-super text-[10px] text-muted-foreground">[{rawIndex}]</span>
    }
    return <AgentCitation evidence={evidence} />
}
