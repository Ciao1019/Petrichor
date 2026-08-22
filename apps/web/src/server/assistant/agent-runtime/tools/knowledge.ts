import { z } from "zod"
import { knowledgeBaseArticlePath, knowledgeBasePath } from "@/lib/dashboard-routes"
import {
    recallKnowledgeCandidates,
    recallKnowledgeCandidatesAcrossKbs,
} from "@/server/kb/knowledge-recall"
import { listUserKnowledgeBases, searchWikiPagesAcrossKbs } from "@/server/kb/wiki-agent-logic"
import {
    listUserWikiOverview,
    readUserWikiPageDetail,
    searchUserWikiPages,
} from "@/server/kb/wiki-qa-user"
import { rewriteQuery } from "@/server/retrieval/query-rewrite"
import { readKnowledgeNode } from "../../tools/knowledge"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolExecutionContext, ToolNormalizerResult } from "../types"

/**
 * 知识能力工具（§24/§30/§31）。
 *
 * search 与 read 严格分离：search 只返回候选（标题/路径/摘要/命中来源/分数），
 * 正文必须由 Agent 判断后显式调用 read。
 */

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const searchSchema = z.object({
    query: z.string().trim().min(1).max(400),
    knowledgeBaseId: idSchema.optional().nullable(),
    limit: z.number().int().min(1).max(20).optional(),
    /** 复杂问题可显式给出子查询并行召回；不给则按规则自动判断 */
    subQueries: z.array(z.string().trim().min(2).max(200)).max(4).optional(),
})

const readSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    nodeKey: z.string().trim().min(1).optional(),
    chunkId: idSchema.optional(),
    pageKey: z.string().trim().min(1).optional(),
    articleId: idSchema.optional(),
}).superRefine((value, ctx) => {
    const count = [value.nodeKey, value.chunkId, value.pageKey, value.articleId].filter((item) => item != null).length
    if (count !== 1) {
        ctx.addIssue({ code: "custom", message: "nodeKey、chunkId、pageKey、articleId 必须且只能提供一个" })
    }
})

const readManySchema = z.object({
    nodes: z.array(readSchema).min(1).max(4),
})

function focusKnowledgeBaseId(focus: unknown): number | null {
    const raw = (focus as { knowledgeBaseId?: string | null } | null)?.knowledgeBaseId
    if (raw == null) return null
    const parsed = Number(String(raw).trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function focusArticleId(focus: unknown): number | undefined {
    const raw = (focus as { articleId?: string | null } | null)?.articleId
    if (raw == null) return undefined
    const parsed = Number(String(raw).trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

async function executeKnowledgeRead(
    ctx: ToolExecutionContext,
    input: z.infer<typeof readSchema>,
): Promise<Record<string, unknown>> {
    const legacyCtx = {
        userId: ctx.userId,
        threadId: ctx.threadId ?? 0,
        runId: ctx.dbRunId ?? 0,
        focus: (ctx.focus ?? null) as never,
        systemRole: ctx.systemRole ?? null,
    }
    // readTreeNodeForAgent 已负责空父节点的子树聚合。这里不再把空章节替换成整篇文章，
    // 避免一次深读把数千字无关正文塞进上下文并造成粗粒度引用。
    return await readKnowledgeNode(legacyCtx, input as never) as Record<string, unknown>
}

/** 章节里的图片/视频/附件引用，来自 readTreeNodeForAgent 的 media 字段 */
type NodeMediaReference = {
    kind?: string
    alt?: string
    src?: string
    filename?: string
}

/**
 * 把媒体清单渲染成一段紧凑文本，放在证据正文之前。
 *
 * 必须放前面：mastra-bridge 只把单条证据的前 1,200 字交给模型
 * （MODEL_EVIDENCE_ITEM_MAX_CHARS）。图片语法虽然本来就在正文里，但章节稍长
 * 就会落在窗口外，模型只看得到图片上下的文字，答案里自然没有图。
 */
function renderMediaManifest(media: NodeMediaReference[]): string {
    const usable = media.filter((item) => typeof item.src === "string" && item.src.trim())
    if (usable.length === 0) return ""
    const lines = usable.slice(0, 12).map((item) => {
        const label = item.alt?.trim() || item.filename?.trim() || "未命名"
        return `- ${item.kind ?? "image"} | ${label} | ${item.src}`
    })
    return `[本章节可引用的媒体]\n${lines.join("\n")}\n\n`
}

function normalizeKnowledgeRead(output: unknown, input: unknown): ToolNormalizerResult {
    const record = output as {
        kind?: string
        title?: string
        articleTitle?: string
        nodeKey?: string
        chunkId?: string
        pageKey?: string
        articleId?: string
        knowledgeBaseId?: string
        path?: string
        contentMd?: string
        content?: string
        contextMd?: string
        contentFrom?: "node" | "subtree" | "empty"
        breadcrumb?: string[]
        media?: NodeMediaReference[]
    }
    const title = record.title ?? record.articleTitle ?? "知识节点"
    const content = (record.contentMd ?? record.content ?? "").trim()
    const context = (record.contextMd ?? "").trim()
    const media = Array.isArray(record.media) ? record.media : []
    const path = record.breadcrumb
        ?? (record.path ? String(record.path).split(/\s*(?:›|\/)\s*/).filter(Boolean) : undefined)
    // Mastra 段内会截取单条证据的前 1,200 字，因此把精简的定位上下文和媒体清单
    // 放在前面，确保模型既知道章节所处层级、有图可引，也仍有足够预算阅读正文。
    const contextPrefix = context ? `[章节定位上下文]\n${context.slice(0, 360)}\n\n` : ""
    const mediaPrefix = renderMediaManifest(media)
    // read_knowledge_node 传 pageKey 时读的是整张 Wiki 页面，和 read_wiki_page_detail
    // 一样属于全文读取，不按章节片段裁剪；分片/章节仍走 4,000 字上限。
    const isWikiPage = record.kind === "wiki_page"
    const body = `${contextPrefix}${mediaPrefix}[${isWikiPage ? "Wiki 页面正文" : "目标章节正文"}]\n${content}`
    const evidenceContent = isWikiPage ? body : body.slice(0, 4_000)
    const fromSubtree = record.contentFrom === "subtree"

    return {
        summary: content
            ? `已读取「${title}」（${content.length} 字${fromSubtree ? "，正文由该章节的子树聚合" : ""}${context ? "，已补充层级上下文" : ""}${media.length > 0 ? `，含 ${media.length} 个媒体引用` : ""}）`
            : `「${title}」没有可引用的正文内容`,
        data: {
            kind: record.kind,
            title,
            nodeKey: record.nodeKey,
            chunkId: record.chunkId,
            articleId: record.articleId,
            contentFrom: record.contentFrom,
            ...(media.length > 0 ? { media } : {}),
            // 正文进证据，不重复进 observation data
            excerpt: content.slice(0, 400),
        },
        evidence: content
            ? [{
                source: "knowledge",
                title,
                content: evidenceContent,
                ...(isWikiPage ? { fullRead: true } : {}),
                // Wiki 页面读取也带 sourceId，与 read_wiki_page_detail 的证据去重口径一致
                ...((record.chunkId ?? record.nodeKey ?? record.pageKey)
                    ? { sourceId: record.chunkId ?? record.nodeKey ?? record.pageKey }
                    : {}),
                relevance: 0.8,
                confidence: 0.8,
                metadata: {
                    ...(record.nodeKey ? { nodeKey: record.nodeKey } : {}),
                    ...(record.chunkId ? { chunkId: record.chunkId } : {}),
                    ...(record.articleId ? { articleId: String(record.articleId) } : {}),
                    ...(record.knowledgeBaseId ? { knowledgeBaseId: String(record.knowledgeBaseId) } : {}),
                    // pageKey 进 metadata 后，证据渲染会附带「Wiki 引用」提示，
                    // 普通问答的回答才能内联 [[pageKey|标题]] 供前端高亮
                    ...(record.pageKey ? { pageKey: record.pageKey } : {}),
                    ...(path ? { path } : {}),
                    ...(record.contentFrom ? { contentFrom: record.contentFrom } : {}),
                    requestedBy: input,
                },
            }]
            : [],
    }
}

function retrievalDisplaySummary(diagnostics: {
    vectorKeys?: unknown[]
    bm25Keys?: unknown[]
    chunkVectorKeys?: unknown[]
    questionVectorKeys?: unknown[]
    wikiKeys?: unknown[]
    treeKeys?: unknown[]
    treeAttempted?: boolean
    rerankStrategy?: string
    degraded?: Record<string, string>
} | undefined): string {
    if (!diagnostics) return "混合检索"
    const methods: string[] = []
    if ((diagnostics.chunkVectorKeys?.length ?? 0) > 0) methods.push("分片语义")
    if ((diagnostics.questionVectorKeys?.length ?? 0) > 0) methods.push("问题语义")
    if ((diagnostics.bm25Keys?.length ?? 0) > 0) methods.push("分片关键词")
    if ((diagnostics.wikiKeys?.length ?? 0) > 0) methods.push("Wiki 页面")
    if (methods.length === 0 && (diagnostics.vectorKeys?.length ?? 0) > 0) methods.push("存量章节语义")
    if (diagnostics.treeAttempted) methods.push("存量目录导航")
    const methodLabel = methods.length > 0
        ? methods.join(" + ")
        : "兼容检索"

    const rerank = diagnostics.rerankStrategy === "external"
        ? "模型重排"
        : diagnostics.rerankStrategy === "local_fallback"
            ? "本地重排（外部服务已降级）"
            : diagnostics.rerankStrategy === "local"
                ? "本地重排"
                : ""
    const tree = diagnostics.treeAttempted ? "" : "Wiki 目录导航未参与"
    const degraded = Object.keys(diagnostics.degraded ?? {}).length > 0 ? "部分召回已降级" : ""
    return [methodLabel, tree, rerank, degraded].filter(Boolean).join("；")
}

type KnowledgeReadBatchOutput = {
    items: Array<{ requested?: unknown; output?: unknown; error?: string }>
    requestedCount: number
    skippedCount: number
}

async function executeKnowledgeReadBatch(
    ctx: ToolExecutionContext,
    nodes: Array<z.infer<typeof readSchema>>,
    limit: number,
): Promise<KnowledgeReadBatchOutput> {
    const selected = nodes.slice(0, limit)
    const settled = await Promise.allSettled(selected.map(async (node) => ({
        requested: node,
        output: await executeKnowledgeRead(ctx, node),
    })))
    return {
        items: settled.map((result, index) => result.status === "fulfilled"
            ? result.value
            : {
                requested: selected[index],
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            }),
        requestedCount: nodes.length,
        skippedCount: Math.max(0, nodes.length - selected.length),
    }
}

function normalizeKnowledgeReadBatch(output: unknown): ToolNormalizerResult {
    const record = output as KnowledgeReadBatchOutput
    const normalized = (record.items ?? [])
        .filter((item) => item.output != null)
        .map((item) => normalizeKnowledgeRead(item.output, item.requested))
    const evidence = normalized.flatMap((item) => item.evidence ?? [])
    const failures = (record.items ?? []).filter((item) => item.error).length
    const notes = [
        failures > 0 ? `${failures} 个章节读取失败` : "",
        (record.skippedCount ?? 0) > 0 ? `按当前问题复杂度跳过 ${record.skippedCount} 个低优先级候选` : "",
    ].filter(Boolean)
    return {
        progress: evidence.length > 0,
        summary: evidence.length > 0
            ? `已并行深读 ${evidence.length} 个相关章节${notes.length ? `（${notes.join("；")}）` : ""}`
            : `没有读到可引用正文${notes.length ? `（${notes.join("；")}）` : ""}`,
        data: {
            items: normalized.map((item) => item.data),
            requestedCount: record.requestedCount ?? record.items?.length ?? 0,
            readCount: evidence.length,
        },
        evidence,
        suggestedActions: evidence.length > 0 ? [] : ["knowledge.search"],
    }
}

function readRequestFromSearchHit(hit: Record<string, unknown>): z.infer<typeof readSchema> | null {
    const knowledgeBaseId = Number(hit.knowledgeBaseId)
    const scope = Number.isInteger(knowledgeBaseId) && knowledgeBaseId > 0 ? { knowledgeBaseId } : {}
    const chunkId = Number(hit.chunkId)
    if (Number.isInteger(chunkId) && chunkId > 0) return { ...scope, chunkId }
    if (typeof hit.nodeKey === "string" && hit.nodeKey.trim()) {
        return { ...scope, nodeKey: hit.nodeKey.trim() }
    }
    if (typeof hit.pageKey === "string" && hit.pageKey.trim()) {
        return { ...scope, pageKey: hit.pageKey.trim() }
    }
    const articleId = Number(hit.articleId)
    if (Number.isInteger(articleId) && articleId > 0) return { ...scope, articleId }
    return null
}

function uniqueReadRequests(hits: Array<Record<string, unknown>>): Array<z.infer<typeof readSchema>> {
    const seen = new Set<string>()
    const nodes: Array<z.infer<typeof readSchema>> = []
    for (const hit of hits) {
        const node = readRequestFromSearchHit(hit)
        if (!node) continue
        const key = `${node.knowledgeBaseId ?? ""}:${node.chunkId ?? node.nodeKey ?? node.pageKey ?? node.articleId ?? ""}`
        if (seen.has(key)) continue
        seen.add(key)
        nodes.push(node)
    }
    return nodes
}

export const knowledgeTools: AgentToolDefinition[] = [
    defineTool({
        id: "knowledge.search",
        name: "search_knowledge",
        namespace: "knowledge",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "检索站内知识库，联合原始分片、分片推荐问题和 Wiki 页面返回候选（不含全文）。"
            + "何时用：需要站内资料支撑结论时，作为第一步定位相关分片或 Wiki 页面。"
            + "输入：query（检索问题）；可选 knowledgeBaseId 限定库、subQueries 拆分复杂问题。"
            + "输出：候选列表，分片含 chunkId，Wiki 含 pageKey；存量数据可能返回 nodeKey。"
            + "何时不用：需要正文时改用 read_knowledge_node；问「有多少库/文章」用概览工具。",
        inputSchema: searchSchema,
        execute: async (ctx, raw) => {
            const input = searchSchema.parse(raw)
            const explicitKb = input.knowledgeBaseId ?? null
            const knowledgeBaseId = explicitKb ?? focusKnowledgeBaseId(ctx.focus)
            const limit = input.limit ?? 10
            const rewritten = input.subQueries?.length
                ? { subQueries: input.subQueries, applied: true }
                : rewriteQuery(input.query)

            // 无库范围 → 跨库 BM25。旧实现只扫描最近 500 条页面/文章，较老资料会永久漏召回。
            // 仍不对每个库强跑向量和 Tree LLM，控制跨库成本（§95/§96）。
            if (knowledgeBaseId == null) {
                const result = await recallKnowledgeCandidatesAcrossKbs({
                    userId: ctx.userId,
                    query: input.query,
                    ...(rewritten.subQueries.length ? { subQueries: rewritten.subQueries } : {}),
                    limit,
                    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
                })

                if (result.candidates.length > 0) {
                    const owned = await listUserKnowledgeBases(ctx.userId)
                    const knowledgeBaseNames = new Map(owned.map((item) => [item.id, item.name]))
                    return {
                        // 保留旧工具协议的 mode，避免现有 Tool UI / prompt 判断失效；
                        // 具体召回实现放在 retrievalMode 和 diagnostics 中。
                        mode: "cross_kb" as const,
                        retrievalMode: "hybrid" as const,
                        hits: result.candidates.map((candidate) => ({
                            ...(candidate.candidateKind === "tree" || (!candidate.chunkId && !candidate.pageKey)
                                ? { nodeKey: candidate.nodeKey }
                                : {}),
                            ...(candidate.chunkId ? { chunkId: candidate.chunkId } : {}),
                            ...(candidate.pageKey ? { pageKey: candidate.pageKey } : {}),
                            articleId: candidate.articleId,
                            knowledgeBaseId: candidate.knowledgeBaseId,
                            knowledgeBaseName: knowledgeBaseNames.get(candidate.knowledgeBaseId) ?? null,
                            href: candidate.articleId
                                ? knowledgeBaseArticlePath(candidate.knowledgeBaseId, candidate.articleId)
                                : knowledgeBasePath(candidate.knowledgeBaseId),
                            title: candidate.title,
                            summary: candidate.summary,
                            score: candidate.score,
                            rerankScore: candidate.rerankScore,
                            recallSources: candidate.recallSources,
                        })),
                        diagnostics: result.diagnostics,
                    }
                }

                // Wiki 尚未编译成 tree node 时保留旧页面/文章检索作为兼容兜底。
                const hits = await searchWikiPagesAcrossKbs({
                    userId: ctx.userId,
                    query: input.query,
                    limit,
                })
                return {
                    mode: "cross_kb" as const,
                    retrievalMode: "legacy" as const,
                    hits: hits.map((hit) => ({
                        knowledgeBaseId: hit.knowledgeBaseId,
                        knowledgeBaseName: hit.knowledgeBaseName,
                        pageKey: hit.pageKey,
                        articleId: hit.articleId,
                        href: hit.href ?? knowledgeBasePath(hit.knowledgeBaseId),
                        title: hit.title,
                        summary: hit.summary,
                        recallSources: ["bm25"],
                    })),
                    diagnostics: result.diagnostics,
                }
            }

            const articleId = explicitKb == null ? focusArticleId(ctx.focus) : undefined
            const result = await recallKnowledgeCandidates({
                userId: ctx.userId,
                knowledgeBaseId,
                query: input.query,
                ...(rewritten.subQueries.length ? { subQueries: rewritten.subQueries } : {}),
                ...(articleId != null ? { articleId } : {}),
                config: { finalTopK: limit },
                // 普通问答先用 Vector+BM25，二者无结果才启用昂贵的 Tree LLM；
                // 只有复杂任务三路并行，保证深度分析仍能获得推理式目录导航的贡献。
                treeMode: ctx.state.complexity === "complex" ? "always" : "fallback",
                ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            })

            const owned = await listUserKnowledgeBases(ctx.userId)
            const knowledgeBaseName = owned.find((item) => item.id === String(knowledgeBaseId))?.name ?? null

            return {
                mode: "hybrid" as const,
                knowledgeBaseId: String(knowledgeBaseId),
                knowledgeBaseName,
                hits: result.candidates.map((candidate) => ({
                    ...(candidate.candidateKind === "tree" || (!candidate.chunkId && !candidate.pageKey)
                        ? { nodeKey: candidate.nodeKey }
                        : {}),
                    ...(candidate.chunkId ? { chunkId: candidate.chunkId } : {}),
                    ...(candidate.pageKey ? { pageKey: candidate.pageKey } : {}),
                    articleId: candidate.articleId,
                    knowledgeBaseId: candidate.knowledgeBaseId,
                    title: candidate.title,
                    ...(candidate.path ? { path: candidate.path } : {}),
                    ...(candidate.summary ? { summary: candidate.summary } : {}),
                    ...(candidate.score != null ? { score: candidate.score } : {}),
                    ...(candidate.rerankScore != null ? { rerankScore: candidate.rerankScore } : {}),
                    recallSources: candidate.recallSources,
                    ...(candidate.reason ? { reason: candidate.reason } : {}),
                    href: candidate.articleId
                        ? knowledgeBaseArticlePath(candidate.knowledgeBaseId, candidate.articleId)
                        : knowledgeBasePath(candidate.knowledgeBaseId),
                })),
                diagnostics: result.diagnostics,
            }
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as {
                mode?: string
                hits?: Array<Record<string, unknown>>
                diagnostics?: {
                    vectorKeys?: unknown[]
                    bm25Keys?: unknown[]
                    treeKeys?: unknown[]
                    treeAttempted?: boolean
                    rerankStrategy?: string
                    degraded?: Record<string, string>
                }
            }
            const hits = record.hits ?? []
            if (hits.length === 0) {
                return {
                    summary: "知识库中未检索到相关内容",
                    data: { hits: [] },
                    suggestedActions: ["rewrite_query", "load_skill:research"],
                }
            }
            return {
                // 找到候选就是进展：正文要靠 knowledge.read 才有证据（§31）
                progress: true,
                summary: `找到 ${hits.length} 个相关章节（${retrievalDisplaySummary(record.diagnostics)}）`,
                // 只回传定位信息，正文交给 read（§30）
                data: {
                    mode: record.mode,
                    hits: hits.map((hit) => ({
                        nodeKey: hit.nodeKey,
                        chunkId: hit.chunkId,
                        pageKey: hit.pageKey,
                        articleId: hit.articleId,
                        knowledgeBaseId: hit.knowledgeBaseId,
                        title: hit.title,
                        path: hit.path,
                        summary: hit.summary,
                        recallSources: hit.recallSources,
                    })),
                },
                suggestedActions: ["knowledge.read_many", "knowledge.read"],
            }
        },
    }),

    defineTool({
        id: "knowledge.lookup",
        name: "lookup_knowledge",
        namespace: "knowledge",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "一次完成知识库检索并深读最相关的 1~2 个章节，每个章节都会生成独立可追溯来源。"
            + "何时用：简单的定义、功能、用途、用法等知识问答，优先用它减少等待。"
            + "输入：query；可选 knowledgeBaseId 限定库。"
            + "输出：候选摘要、召回诊断、章节正文与独立证据。"
            + "何时不用：复杂比较、跨主题研究或需要自主挑选更多章节时，改用 search_knowledge + read_knowledge_nodes。",
        inputSchema: searchSchema,
        execute: async (ctx, raw) => {
            const input = searchSchema.parse(raw)
            const searchTool = knowledgeTools.find((item) => item.id === "knowledge.search")
            if (!searchTool) throw new Error("knowledge.search 未注册")

            // 快车道只需少量候选供两阶段筛选，避免把十条摘要重复塞回模型。
            const searchOutput = await searchTool.execute(ctx, {
                ...input,
                limit: input.limit ?? 6,
            })
            const searchRecord = searchOutput as {
                hits?: Array<Record<string, unknown>>
            }
            const nodes = uniqueReadRequests(searchRecord.hits ?? [])
            const reads = await executeKnowledgeReadBatch(ctx, nodes, 2)
            return {
                ...(searchOutput as Record<string, unknown>),
                reads,
            }
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as {
                mode?: string
                hits?: Array<Record<string, unknown>>
                diagnostics?: {
                    vectorKeys?: unknown[]
                    bm25Keys?: unknown[]
                    treeKeys?: unknown[]
                    treeAttempted?: boolean
                    rerankStrategy?: string
                    degraded?: Record<string, string>
                }
                reads?: KnowledgeReadBatchOutput
            }
            const hits = record.hits ?? []
            const readResult = normalizeKnowledgeReadBatch(record.reads ?? {
                items: [],
                requestedCount: 0,
                skippedCount: 0,
            })
            const evidence = readResult.evidence ?? []
            const retrieval = retrievalDisplaySummary(record.diagnostics)

            if (hits.length === 0) {
                return {
                    summary: "知识库中未检索到相关内容",
                    data: { hits: [], readCount: 0 },
                    suggestedActions: ["rewrite_query", "load_skill:research"],
                }
            }

            return {
                progress: true,
                summary: evidence.length > 0
                    ? `找到 ${hits.length} 个相关章节并深读 ${evidence.length} 个（${retrieval}）`
                    : `找到 ${hits.length} 个候选章节，但没有读到可引用正文（${retrieval}）`,
                data: {
                    mode: record.mode,
                    hits: hits.map((hit) => ({
                        nodeKey: hit.nodeKey,
                        chunkId: hit.chunkId,
                        pageKey: hit.pageKey,
                        articleId: hit.articleId,
                        knowledgeBaseId: hit.knowledgeBaseId,
                        title: hit.title,
                        path: hit.path,
                        summary: hit.summary,
                        recallSources: hit.recallSources,
                    })),
                    reads: readResult.data,
                },
                evidence,
                suggestedActions: evidence.length > 0 ? [] : ["knowledge.read_many", "knowledge.read"],
            }
        },
    }),

    defineTool({
        id: "knowledge.read_many",
        name: "read_knowledge_nodes",
        namespace: "knowledge",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "一次并行读取多个知识章节，是 search 后深读候选的首选工具。"
            + "何时用：需要比较或综合 2~4 个候选章节；简单问题最多读取 2 个，复杂问题最多 4 个。"
            + "输入：nodes 数组，每项均为 chunkId、pageKey、nodeKey、articleId 四选一，并可携带 knowledgeBaseId。"
            + "输出：每个章节的正文、层级上下文与独立可追溯证据。"
            + "何时不用：只需读取一个明确章节时用 read_knowledge_node。",
        inputSchema: readManySchema,
        execute: async (ctx, raw) => {
            const input = readManySchema.parse(raw)
            const limit = ctx.state.complexity === "simple" ? 2 : 4
            return await executeKnowledgeReadBatch(ctx, input.nodes, limit)
        },
        normalize: normalizeKnowledgeReadBatch,
    }),

    defineTool({
        id: "knowledge.read",
        name: "read_knowledge_node",
        namespace: "knowledge",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "读取知识库某个原始分片、Wiki 页面、存量节点或整篇文章的正文。"
            + "何时用：search 定位到候选后，对真正相关的 1~3 条深读。"
            + "输入：chunkId、pageKey、nodeKey、articleId 四选一；跨库检索命中的条目必须带上其 knowledgeBaseId。"
            + "输出：正文、面包屑、子节点、媒体引用。"
            + "何时不用：不要把所有候选都读一遍；只需要标题清单时用 search。",
        inputSchema: readSchema,
        execute: async (ctx, raw) => await executeKnowledgeRead(ctx, readSchema.parse(raw)),
        normalize: normalizeKnowledgeRead,
    }),

    defineTool({
        id: "knowledge.list_bases",
        name: "list_knowledge_bases",
        namespace: "knowledge",
        riskLevel: "low",
        sideEffect: false,
        description:
            "列出当前用户拥有的知识库。"
            + "何时用：需要确定检索范围，或回答「我有哪些知识库」。"
            + "输入：无。输出：知识库 id、名称、描述。"
            + "何时不用：要查内容时用 search_knowledge。",
        inputSchema: z.object({}),
        execute: async (ctx) => await listUserKnowledgeBases(ctx.userId),
        normalize: (output): ToolNormalizerResult => {
            const list = Array.isArray(output) ? output : []
            return { summary: `共 ${list.length} 个知识库`, data: { knowledgeBases: list } }
        },
    }),
]

const wikiQueriesSchema = z.object({
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
    knowledgeBaseId: idSchema.optional().nullable(),
    limit: z.number().int().min(1).max(20).optional(),
})

/**
 * Wiki 问答工具组（参考 Tencent/WeKnora 的 wiki_overview / wiki_search / wiki_read_page）。
 * 带 wiki 标签：常态不占用核心工具名额，Wiki 问答模式下由 Runtime 解锁。
 */
export const wikiQaTools: AgentToolDefinition[] = [
    defineTool({
        id: "knowledge.wiki_overview",
        name: "wiki_overview",
        namespace: "knowledge",
        riskLevel: "low",
        sideEffect: false,
        tags: ["wiki"],
        description:
            "列出 Wiki 页面分组概览：主题与知识页（概念/实体/对比/答案）+ 源文档页，每页含 pageKey、标题与摘要。"
            + "何时用：Wiki 问答的第一步，先掌握全貌再决定读哪些页面。"
            + "输入：无；可选 knowledgeBaseId 限定库（缺省沿用当前提问范围）。"
            + "输出：分组页面目录。已知 pageKey 时可直接 read_wiki_page_detail。",
        inputSchema: z.object({}),
        execute: async (ctx) => {
            const overview = await listUserWikiOverview({
                userId: ctx.userId,
                knowledgeBaseId: focusKnowledgeBaseId(ctx.focus),
            })
            return {
                ...overview,
                emptyMessage: overview.total === 0 ? "当前范围内还没有可用的 Wiki 页面" : undefined,
            }
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as {
                groups?: Array<{ key?: string; label?: string; pages?: Array<Record<string, unknown>> }>
                total?: number
                emptyMessage?: string
            }
            const total = record.total ?? 0
            if (total === 0) {
                return {
                    summary: record.emptyMessage ?? "没有可用的 Wiki 页面",
                    data: { total: 0 },
                }
            }
            return {
                progress: true,
                summary: `Wiki 共 ${total} 个页面：${(record.groups ?? [])
                    .map((group) => `${group.label ?? group.key}${group.pages?.length ?? 0}`)
                    .join("、")}`,
                data: {
                    total,
                    pages: (record.groups ?? []).flatMap((group) =>
                        (group.pages ?? []).map((page) => ({
                            pageKey: page.pageKey,
                            title: page.title,
                            kind: page.kind,
                            summary: page.summary,
                        })),
                    ).slice(0, 60),
                },
                suggestedActions: ["knowledge.search_wiki_pages", "knowledge.read_wiki_page_detail"],
            }
        },
    }),

    defineTool({
        id: "knowledge.search_wiki_pages",
        name: "search_wiki_pages",
        namespace: "knowledge",
        riskLevel: "low",
        sideEffect: false,
        tags: ["wiki"],
        description:
            "在 Wiki 页面里做多关键词检索：queries 一次传多个词（同义概念、别名词一起搜），"
            + "命中标题/摘要/别名/正文，返回 pageKey、标题、类型、别名、摘要与正文命中片段。"
            + "何时用：不知道确切 pageKey 时定位 Wiki 页面。"
            + "何时不用：要浏览全貌用 wiki_overview；要正文用 read_wiki_page_detail。",
        inputSchema: wikiQueriesSchema,
        execute: async (ctx, raw) => {
            const input = wikiQueriesSchema.parse(raw)
            return await searchUserWikiPages({
                userId: ctx.userId,
                queries: input.queries,
                limit: input.limit,
                knowledgeBaseId: input.knowledgeBaseId ?? focusKnowledgeBaseId(ctx.focus),
            })
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as { query?: string[]; items?: Array<Record<string, unknown>>; emptyMessage?: string }
            const items = record.items ?? []
            if (items.length === 0) {
                return {
                    summary: record.emptyMessage ?? "没有匹配的 Wiki 页面",
                    data: { items: [] },
                    suggestedActions: ["knowledge.wiki_overview", "rewrite_query"],
                }
            }
            return {
                progress: true,
                summary: `命中 ${items.length} 个 Wiki 页面（关键词：${(record.query ?? []).join(" / ")}）`,
                data: {
                    items: items.map((item) => ({
                        pageKey: item.pageKey,
                        title: item.title,
                        kind: item.kind,
                        aliases: item.aliases,
                        summary: item.summary,
                        snippet: item.snippet,
                    })),
                },
                suggestedActions: ["knowledge.read_wiki_page_detail"],
            }
        },
    }),

    defineTool({
        id: "knowledge.read_wiki_page_detail",
        name: "read_wiki_page_detail",
        namespace: "knowledge",
        riskLevel: "low",
        sideEffect: false,
        tags: ["wiki"],
        description:
            "按 pageKey 读取一篇 Wiki 页面：全文 Markdown + 关联页面（links/inLinks，各带标题与摘要）+ 来源文章。"
            + "何时用：search_wiki_pages 或 wiki_overview 定位到相关页面后深读。"
            + "输入：pageKey 必填；可选 knowledgeBaseId 消除跨库同名歧义。"
            + "输出：页面全文与关联信息；回答时用 [[pageKey|标题]] 引用该页面。",
        inputSchema: z.object({
            pageKey: z.string().trim().min(1).max(200),
            knowledgeBaseId: idSchema.optional().nullable(),
        }),
        execute: async (ctx, raw) => {
            const input = z.object({
                pageKey: z.string().trim().min(1).max(200),
                knowledgeBaseId: idSchema.optional().nullable(),
            }).parse(raw)
            return await readUserWikiPageDetail({
                userId: ctx.userId,
                pageKey: input.pageKey,
                knowledgeBaseId: input.knowledgeBaseId ?? focusKnowledgeBaseId(ctx.focus),
            })
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as {
                pageKey?: string
                title?: string
                kind?: string
                contentMd?: string
                links?: Array<Record<string, unknown>>
                inLinks?: Array<Record<string, unknown>>
                sourceArticles?: Array<Record<string, unknown>>
            }
            const title = record.title ?? record.pageKey ?? "Wiki 页面"
            const content = (record.contentMd ?? "").trim()
            if (!content) {
                return {
                    summary: `「${title}」没有可引用的正文内容`,
                    data: { pageKey: record.pageKey, title },
                }
            }
            const neighborCount = (record.links?.length ?? 0) + (record.inLinks?.length ?? 0)
            // 全文读取：正文完整进证据，不在这里裁。工具说明和提示词都写着"读全文"，
            // 截一刀会让模型看到 summary 的字数与正文对不上，判定页面被截断并绕去读源文档。
            // 体积由 mastra-bridge（段内回传）与 context-manager（evidence budget）统一兜底。
            const evidenceContent = `[Wiki 页面 ${title}]\n\n${content}`
            return {
                progress: true,
                summary: `已读取 Wiki 页面「${title}」（${content.length} 字${neighborCount > 0 ? `，${neighborCount} 个关联页面` : ""}），回答时请用 [[${record.pageKey}|${title}]] 引用`,
                data: {
                    pageKey: record.pageKey,
                    title,
                    kind: record.kind,
                    excerpt: content.slice(0, 400),
                    links: (record.links ?? []).slice(0, 12).map((link) => ({
                        pageKey: link.pageKey,
                        title: link.title,
                        summary: link.summary,
                    })),
                    inLinks: (record.inLinks ?? []).slice(0, 12).map((link) => ({
                        pageKey: link.pageKey,
                        title: link.title,
                        summary: link.summary,
                    })),
                    sourceArticles: record.sourceArticles ?? [],
                },
                evidence: [{
                    source: "wiki",
                    title,
                    content: evidenceContent,
                    fullRead: true,
                    ...(record.pageKey ? { sourceId: record.pageKey } : {}),
                    relevance: 0.85,
                    confidence: 0.85,
                    metadata: {
                        ...(record.pageKey ? { pageKey: record.pageKey } : {}),
                        kind: record.kind,
                    },
                }],
                suggestedActions: ["knowledge.read_wiki_page_detail"],
            }
        },
    }),
]
