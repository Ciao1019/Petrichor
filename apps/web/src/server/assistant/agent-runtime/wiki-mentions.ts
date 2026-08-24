import {
    mergeWikiMentionTargets,
    type WikiMentionTarget,
} from "@/lib/wiki-mentions"
import type { AgentEvidence, AgentObservation } from "./types"

export {
    annotateNormalQaWikiMentions,
    mergeWikiMentionTargets,
    type WikiMentionTarget,
} from "@/lib/wiki-mentions"

type RawWikiMentionTarget = {
    pageKey?: unknown
    title?: unknown
    aliases?: unknown
    kind?: unknown
    pageKind?: unknown
}

function toTarget(raw: RawWikiMentionTarget, citationIndex: number | null = null): WikiMentionTarget | null {
    const pageKey = typeof raw.pageKey === "string" ? raw.pageKey.trim() : ""
    const title = typeof raw.title === "string" ? raw.title.trim() : ""
    if (!pageKey || !title) return null
    const aliases = Array.isArray(raw.aliases)
        ? raw.aliases.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean)
        : []
    const kindValue = raw.pageKind ?? raw.kind
    return {
        pageKey,
        title,
        aliases,
        kind: typeof kindValue === "string" && kindValue.trim() ? kindValue.trim() : null,
        citationIndex,
    }
}

/** 汇总本轮已经检索或深读过的真实 Wiki 页面，不根据答案文本编造 pageKey。 */
export function collectWikiMentionTargets(
    evidence: AgentEvidence[],
    observations: AgentObservation[],
    citationIndex: (evidence: AgentEvidence) => number,
): WikiMentionTarget[] {
    const targets: WikiMentionTarget[] = []
    const append = (raw: RawWikiMentionTarget, index: number | null = null) => {
        const target = toTarget(raw, index)
        if (target) targets.push(target)
    }

    for (const item of evidence) {
        const metadata = item.metadata ?? {}
        append({
            pageKey: metadata.pageKey,
            title: item.title,
            aliases: metadata.aliases,
            pageKind: metadata.pageKind,
        }, citationIndex(item))
        const related = Array.isArray(metadata.wikiTargets) ? metadata.wikiTargets : []
        for (const target of related) append(target as RawWikiMentionTarget)
    }

    for (const observation of observations) {
        if (observation.isError || !observation.data || typeof observation.data !== "object") continue
        const data = observation.data as { hits?: unknown; wikiTargets?: unknown; items?: unknown }
        for (const value of [data.hits, data.wikiTargets, data.items]) {
            if (!Array.isArray(value)) continue
            for (const target of value) append(target as RawWikiMentionTarget)
        }
    }

    return mergeWikiMentionTargets(targets)
}
