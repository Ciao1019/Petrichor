import { resolveRerankConfig, type RerankConfig } from "@/server/assistant/agent-runtime/config"
import { buildQueryTokens } from "./tokenize"

/**
 * 可插拔 Reranker（§29/§92/§141）。
 *
 * - 未配置或调用失败时必须优雅降级：直接返回 RRF 融合顺序，不影响主流程；
 * - 支持 OpenAI 兼容的 /rerank 端点（BGE Reranker、Cross Encoder 等自托管服务通用）。
 */

export type RerankCandidate = {
    nodeKey: string
    title?: string | null
    summary?: string | null
    content?: string | null
}

export type RerankedCandidate<T extends RerankCandidate = RerankCandidate> = T & {
    rerankScore?: number
}

export type RerankOptions = {
    topN?: number
    signal?: AbortSignal
}

export interface Reranker {
    readonly id: string
    rerank<T extends RerankCandidate>(
        query: string,
        candidates: T[],
        options?: RerankOptions,
    ): Promise<Array<RerankedCandidate<T>>>
}

/** 关闭 rerank 时使用：原样返回，保持 RRF 顺序 */
export class NoopReranker implements Reranker {
    readonly id = "noop"

    async rerank<T extends RerankCandidate>(_query: string, candidates: T[], options?: RerankOptions) {
        return options?.topN ? candidates.slice(0, options.topN) : candidates
    }
}

/**
 * 无外部 Cross Encoder 时使用的轻量本地重排。
 *
 * 混合召回的 RRF 主要解决「不同分数不可比」，这里再根据原问题对标题、摘要、正文
 * 做一次字段加权，修正“多个召回源都命中，但真正回答问题的章节排在后面”的情况。
 * 它不发网络请求，耗时通常只有毫秒级，因此可以作为默认能力和外部服务的降级路径。
 */
export class LocalLexicalReranker implements Reranker {
    readonly id = "local-lexical"

    async rerank<T extends RerankCandidate>(
        query: string,
        candidates: T[],
        options?: RerankOptions,
    ): Promise<Array<RerankedCandidate<T>>> {
        const tokens = buildQueryTokens(query)
        const normalizedQuery = normalize(query)
        const scored = candidates.map((candidate, index) => {
            const title = normalize(candidate.title ?? "")
            const summary = normalize(candidate.summary ?? "")
            const content = normalize(candidate.content ?? "")
            let score = 1 / (index + 2)

            if (normalizedQuery) {
                if (title.includes(normalizedQuery)) score += 8
                if (summary.includes(normalizedQuery)) score += 4
                if (content.includes(normalizedQuery)) score += 2
            }
            for (const token of tokens) {
                const normalizedToken = normalize(token)
                if (!normalizedToken) continue
                if (title.includes(normalizedToken)) score += 4
                if (summary.includes(normalizedToken)) score += 2
                if (content.includes(normalizedToken)) score += 1
            }

            return { candidate, index, score }
        })

        return scored
            .sort((left, right) => right.score - left.score || left.index - right.index)
            .slice(0, options?.topN ?? candidates.length)
            .map(({ candidate, score }) => ({
                ...candidate,
                rerankScore: Number(score.toFixed(6)),
            }))
    }
}

/** OpenAI 兼容 rerank 端点：POST {baseUrl}/rerank { model, query, documents } */
export class OpenAiCompatibleReranker implements Reranker {
    readonly id: string

    constructor(private readonly config: RerankConfig) {
        this.id = `${config.provider}:${config.model}`
    }

    async rerank<T extends RerankCandidate>(
        query: string,
        candidates: T[],
        options?: RerankOptions,
    ): Promise<Array<RerankedCandidate<T>>> {
        if (candidates.length === 0) return []
        if (!this.config.baseUrl) throw new Error("RAG_RERANK_BASE_URL 未配置")

        const documents = candidates.map((candidate) => renderDocument(candidate))
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
        options?.signal?.addEventListener("abort", () => controller.abort(), { once: true })

        try {
            const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/rerank`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.config.model,
                    query,
                    documents,
                    top_n: options?.topN ?? this.config.topN,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                throw new Error(`rerank 服务返回 ${response.status}`)
            }
            const payload = await response.json() as {
                results?: Array<{ index: number; relevance_score?: number; score?: number }>
            }
            const results = payload.results ?? []
            if (results.length === 0) return candidates

            return results
                .filter((item) => item.index >= 0 && item.index < candidates.length)
                .map((item) => ({
                    ...candidates[item.index],
                    rerankScore: item.relevance_score ?? item.score ?? 0,
                }))
        } finally {
            clearTimeout(timer)
        }
    }
}

export function createReranker(config: RerankConfig = resolveRerankConfig()): Reranker {
    if (!config.enabled) return new NoopReranker()
    switch (config.provider) {
        case "openai-compatible":
        case "bge":
        case "cross-encoder":
            return new OpenAiCompatibleReranker(config)
        default:
            return new NoopReranker()
    }
}

/**
 * 带兜底的 rerank：失败即回落到传入顺序（§141 Reranker 挂了 → fallback RRF）。
 * 返回值同时告知调用方是否真的重排过，便于写入检索诊断。
 */
export async function rerankWithFallback<T extends RerankCandidate>(
    reranker: Reranker,
    query: string,
    candidates: T[],
    options?: RerankOptions,
): Promise<{ items: Array<RerankedCandidate<T>>; applied: boolean; error?: string; durationMs: number }> {
    const startedAt = Date.now()
    if (reranker.id === "noop" || candidates.length <= 1) {
        return {
            items: options?.topN ? candidates.slice(0, options.topN) : candidates,
            applied: false,
            durationMs: 0,
        }
    }
    try {
        const items = await reranker.rerank(query, candidates, options)
        return { items, applied: true, durationMs: Date.now() - startedAt }
    } catch (error) {
        return {
            items: options?.topN ? candidates.slice(0, options.topN) : candidates,
            applied: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        }
    }
}

export type AdaptiveRerankResult<T extends RerankCandidate> = {
    items: Array<RerankedCandidate<T>>
    applied: boolean
    strategy: "external" | "local" | "local_fallback" | "skipped"
    error?: string
    durationMs: number
}

/**
 * 自适应重排：候选过少时跳过；外部服务已配置时优先使用，失败则本地降级；
 * 未配置外部服务时直接使用本地重排，避免默认配置下 rerank 永远不生效。
 */
export async function rerankAdaptively<T extends RerankCandidate>(
    configured: Reranker,
    query: string,
    candidates: T[],
    options?: RerankOptions,
): Promise<AdaptiveRerankResult<T>> {
    if (candidates.length <= 1) {
        return {
            items: options?.topN ? candidates.slice(0, options.topN) : candidates,
            applied: false,
            strategy: "skipped",
            durationMs: 0,
        }
    }

    if (configured.id === "noop") {
        const local = await rerankWithFallback(new LocalLexicalReranker(), query, candidates, options)
        return { ...local, strategy: local.applied ? "local" : "skipped" }
    }

    const external = await rerankWithFallback(configured, query, candidates, options)
    if (external.applied) return { ...external, strategy: "external" }

    const local = await rerankWithFallback(new LocalLexicalReranker(), query, candidates, options)
    return {
        ...local,
        strategy: local.applied ? "local_fallback" : "skipped",
        ...(external.error ? { error: external.error } : {}),
        durationMs: external.durationMs + local.durationMs,
    }
}

function renderDocument(candidate: RerankCandidate): string {
    return [candidate.title, candidate.summary, candidate.content?.slice(0, 1_200)]
        .filter(Boolean)
        .join("\n")
}

function normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, "").trim()
}
