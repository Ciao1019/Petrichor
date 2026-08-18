import type { AgentState, AgentTrace } from "./types"

/**
 * Agent Eval 指标（§72~§77）。
 *
 * 这里只做"从一次 Run 的 State/Trace 里算出可比指标"，不做打分模型。
 * 指标随 Trace 一起落库，离线聚合即可回答：Router 还有没有价值、
 * 子代理是否必要、是否存在过度检索。
 */

export type AgentRunEval = {
    runId: string
    complexity: string
    stopReason?: string
    /** 是否产出了非空答案且未因异常终止 */
    taskSuccess: boolean

    steps: number
    toolCalls: number
    failedToolCalls: number
    duplicateToolCalls: number
    /** 没有产生任何证据的工具调用数（近似"无用调用"） */
    unproductiveToolCalls: number

    evidenceCount: number
    /** 答案中出现的 [n] 引用数 / 证据数 */
    citationCoverage: number

    skillLoads: number
    /** Router 预测域 与 实际使用工具 namespace 的一致度 */
    routerPrecision: number | null
    routerPredictedDomains: string[]
    actualNamespaces: string[]

    subAgentCount: number
    subAgentUsefulCount: number
    /** 并行是否真的省了时间：串行耗时和 / 实际墙钟耗时 */
    delegationSpeedup: number | null

    loopDetected: boolean
    errorRate: number

    tokenUsage: { input: number; output: number; total: number }
    latency: {
        totalMs?: number
        ttftMs?: number
        toolMs?: number
        llmMs?: number
        subAgentMs?: number
        retrievalMs?: number
        rerankMs?: number
    }
}

export function evaluateRun(input: {
    state: AgentState
    trace: AgentTrace
    answer: string
}): AgentRunEval {
    const { state, trace, answer } = input
    const toolCalls = trace.toolCalls
    const failed = toolCalls.filter((call) => !call.ok)
    const unproductive = toolCalls.filter((call) => call.ok && call.evidenceIds.length === 0)

    const signatures = toolCalls.map((call) => `${call.toolId}:${JSON.stringify(call.input ?? {})}`)
    const duplicates = signatures.length - new Set(signatures).size

    const actualNamespaces = [...new Set(toolCalls.map((call) => call.namespace))]
    const predicted = trace.routingHint?.domains ?? []
    const routerPrecision = predicted.length === 0
        ? null
        : predicted.filter((domain) => actualNamespaces.some((ns) => ns.includes(domain) || domain.includes(ns))).length
            / predicted.length

    const citations = new Set((answer.match(/\[(\d{1,2})\]/g) ?? []).map((token) => token.slice(1, -1)))
    const citationCoverage = state.evidence.length === 0
        ? 0
        : Math.min(1, citations.size / state.evidence.length)

    const usefulSubAgents = trace.delegations.filter(
        (item) => item.status === "completed" && item.evidenceCount > 0,
    ).length
    const serialMs = trace.delegations.reduce((sum, item) => sum + item.durationMs, 0)
    const delegationSpeedup = trace.delegations.length > 1 && trace.latency.subAgentMs
        ? Number((serialMs / Math.max(1, trace.latency.subAgentMs)).toFixed(2))
        : null

    return {
        runId: trace.runId,
        complexity: state.complexity,
        ...(trace.stopReason ? { stopReason: trace.stopReason } : {}),
        taskSuccess: answer.trim().length > 0
            && state.status !== "failed"
            && state.stopReason !== "fatal_error",

        steps: trace.steps.length,
        toolCalls: toolCalls.length,
        failedToolCalls: failed.length,
        duplicateToolCalls: duplicates,
        unproductiveToolCalls: unproductive.length,

        evidenceCount: state.evidence.length,
        citationCoverage: Number(citationCoverage.toFixed(3)),

        skillLoads: trace.skillLoads.length,
        routerPrecision: routerPrecision == null ? null : Number(routerPrecision.toFixed(3)),
        routerPredictedDomains: predicted,
        actualNamespaces,

        subAgentCount: trace.delegations.length,
        subAgentUsefulCount: usefulSubAgents,
        delegationSpeedup,

        loopDetected: state.stopReason === "loop_detected" || state.stopReason === "no_progress",
        errorRate: toolCalls.length === 0 ? 0 : Number((failed.length / toolCalls.length).toFixed(3)),

        tokenUsage: trace.tokenUsage,
        latency: trace.latency,
    }
}

/**
 * 检索质量指标（§75）。由 knowledge.search 的诊断事件聚合。
 * 需要标注集时才能算 Recall@K / MRR，这里先把各路召回贡献算出来。
 */
export type RetrievalEval = {
    query: string
    treeHits: number
    vectorHits: number
    bm25Hits: number
    fusionSize: number
    finalSize: number
    /** 各召回源在最终结果中的占比 */
    contribution: { tree: number; vector: number; bm25: number }
    rerankApplied: boolean
    /** 有标注时才有值 */
    recallAtK?: number
    mrr?: number
}

export function evaluateRetrieval(input: {
    query: string
    treeKeys: string[]
    vectorKeys: string[]
    bm25Keys: string[]
    fusionKeys: string[]
    finalKeys: string[]
    rerankApplied: boolean
    relevantKeys?: string[]
}): RetrievalEval {
    const final = new Set(input.finalKeys)
    const share = (keys: string[]) => (final.size === 0 ? 0 : keys.filter((key) => final.has(key)).length / final.size)

    const result: RetrievalEval = {
        query: input.query,
        treeHits: input.treeKeys.length,
        vectorHits: input.vectorKeys.length,
        bm25Hits: input.bm25Keys.length,
        fusionSize: input.fusionKeys.length,
        finalSize: input.finalKeys.length,
        contribution: {
            tree: Number(share(input.treeKeys).toFixed(3)),
            vector: Number(share(input.vectorKeys).toFixed(3)),
            bm25: Number(share(input.bm25Keys).toFixed(3)),
        },
        rerankApplied: input.rerankApplied,
    }

    if (input.relevantKeys?.length) {
        const relevant = new Set(input.relevantKeys)
        const hit = input.finalKeys.filter((key) => relevant.has(key)).length
        result.recallAtK = Number((hit / relevant.size).toFixed(3))
        const firstIndex = input.finalKeys.findIndex((key) => relevant.has(key))
        result.mrr = firstIndex >= 0 ? Number((1 / (firstIndex + 1)).toFixed(3)) : 0
    }

    return result
}
