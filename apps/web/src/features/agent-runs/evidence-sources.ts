import type { EvidenceViewModel } from "./types"

/**
 * 前端的真实来源归并口径，与后端 EvidenceStore 保持一致。
 * 一篇文章可包含多条章节证据，但来源计数和引用编号只占一个位置。
 */
export function evidenceSourceKey(evidence: EvidenceViewModel): string {
    const knowledgeBaseId = evidence.knowledgeBaseId?.trim() ?? ""
    const scope = knowledgeBaseId ? `${knowledgeBaseId}:` : ""

    if ((evidence.source === "knowledge" || evidence.source === "wiki") && evidence.pageKey?.trim()) {
        return `wiki:${scope}${evidence.pageKey.trim()}`
    }
    if (evidence.source === "knowledge" && evidence.articleId?.trim()) {
        return `knowledge-article:${scope}${evidence.articleId.trim()}`
    }
    if (evidence.url?.trim()) return `url:${canonicalUrl(evidence.url)}`
    if (evidence.nodeKey?.trim()) return `node:${evidence.source}:${scope}${evidence.nodeKey.trim()}`
    return `evidence:${evidence.id}`
}

/** 后端旧事件没有 citationIndex 时也能按真实来源补出稳定编号。 */
export function assignEvidenceCitationIndices(evidence: EvidenceViewModel[]): EvidenceViewModel[] {
    const indices = new Map<string, number>()
    let nextIndex = 0

    return evidence.map((item) => {
        const key = evidenceSourceKey(item)
        const known = indices.get(key)
        if (known != null) return item.citationIndex === known ? item : { ...item, citationIndex: known }

        const explicit = Number.isInteger(item.citationIndex) && item.citationIndex > 0
            ? item.citationIndex
            : undefined
        const citationIndex = explicit ?? nextIndex + 1
        nextIndex = Math.max(nextIndex, citationIndex)
        indices.set(key, citationIndex)
        return item.citationIndex === citationIndex ? item : { ...item, citationIndex }
    })
}

export type EvidenceSourceGroup = {
    key: string
    evidence: EvidenceViewModel[]
}

export function groupEvidenceBySource(evidence: EvidenceViewModel[]): EvidenceSourceGroup[] {
    const groups = new Map<string, EvidenceViewModel[]>()
    for (const item of evidence) {
        const key = evidenceSourceKey(item)
        const current = groups.get(key)
        if (current) current.push(item)
        else groups.set(key, [item])
    }
    return [...groups].map(([key, items]) => ({ key, evidence: items }))
}

function canonicalUrl(raw: string): string {
    try {
        const url = new URL(raw)
        url.hash = ""
        url.protocol = "https:"
        url.hostname = url.hostname.replace(/^www\./, "").toLowerCase()
        const drop: string[] = []
        url.searchParams.forEach((_value, key) => {
            if (/^(utm_|ref$|referrer$|fbclid$|gclid$|spm$|from$)/i.test(key)) drop.push(key)
        })
        for (const key of drop) url.searchParams.delete(key)
        const search = url.searchParams.toString()
        const pathname = url.pathname.replace(/\/+$/, "") || "/"
        return `${url.hostname}${pathname}${search ? `?${search}` : ""}`
    } catch {
        return raw.trim().toLowerCase().replace(/\/+$/, "")
    }
}
