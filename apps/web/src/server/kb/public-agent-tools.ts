import { z } from "zod"
import {
    defineTool,
} from "@/server/assistant/agent-runtime/tools/adapter"
import {
    normalizeKnowledgeRead,
    normalizeKnowledgeReadBatch,
    normalizeKnowledgeSearch,
    normalizeWikiOverview,
    normalizeWikiPageDetail,
    normalizeWikiSearchPages,
    retrievalDisplaySummary,
    type KnowledgeReadBatchOutput,
} from "@/server/assistant/agent-runtime/tools/knowledge"
import type {
    AgentToolDefinition,
    ToolExecutionContext,
    ToolNormalizerResult,
} from "@/server/assistant/agent-runtime/types"
import { readKnowledgeNode } from "@/server/assistant/tools/knowledge"
import { notFound } from "@/server/http/response"
import { recallKnowledgeCandidatesAcrossKbs } from "@/server/kb/knowledge-recall"
import {
    buildPublicArticleHref,
    type PublicArticleScope,
} from "@/server/kb/public-qa-logic"
import {
    assertPublicWikiPageAccessible,
    listPublicWikiOverview,
    readPublicWikiPageDetail,
    searchPublicWikiPages,
} from "@/server/kb/public-wiki-qa"
import { rewriteQuery } from "@/server/retrieval/query-rewrite"

/**
 * 公开问答（前台 /ask）的 Agent 只读工具集。
 *
 * 与后台助手共用 AgentRuntime v2 的执行框架与证据归一化，差异只有两点：
 * 1. 数据边界：全部读取都经 loadPublicArticleScope() 白名单过滤，
 *    白名单外的资源一律按「不在公开范围」拒绝，杜绝越权读取私有内容；
 * 2. 检索范围：不提供知识库选择（无 focus、不接受 knowledgeBaseId 入参），
 *    始终在站长全库范围内检索后再按公开白名单收窄。
 *
 * 工具 id 与后台保持一致（knowledge.*），使活动聚合、工具标题等 UI 映射直接生效。
 */

/** 一次跨库检索最多送入白名单过滤的候选数：放大召回再收窄，避免未公开文章挤占名额 */
const SEARCH_OVERFETCH_FACTOR = 3

const searchSchema = z.object({
    query: z.string().trim().min(1).max(400),
    limit: z.number().int().min(1).max(20).optional(),
    subQueries: z.array(z.string().trim().min(2).max(200)).max(4).optional(),
})

const readNodeSchema = z.object({
    knowledgeBaseId: z.union([z.string(), z.number()]).optional().nullable(),
    nodeKey: z.string().trim().min(1).optional(),
    chunkId: z.union([z.string(), z.number()]).optional(),
    pageKey: z.string().trim().min(1).optional(),
    articleId: z.union([z.string(), z.number()]).optional(),
}).superRefine((value, ctx) => {
    const count = [value.nodeKey, value.chunkId, value.pageKey, value.articleId]
        .filter((item) => item != null).length
    if (count !== 1) {
        ctx.addIssue({ code: "custom", message: "nodeKey、chunkId、pageKey、articleId 必须且只能提供一个" })
    }
})

function toId(value: string | number | null | undefined): number | null {
    if (value == null) return null
    const parsed = Number(String(value).trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

type KnowledgeReadOutput = {
    kind?: string
    title?: string
    articleTitle?: string
    nodeKey?: string
    chunkId?: string
    pageKey?: string
    articleId?: string | number
    knowledgeBaseId?: string | number
    contentMd?: string
    content?: string
}

/** 从读取结果里取出所属文章 id；拿不到时视为不可定位，一律拒绝。 */
function readOutputArticleId(output: unknown): number | null {
    const record = output as KnowledgeReadOutput
    return toId(record?.articleId ?? null)
}

/**
 * 公开问答的统一证据出口：
 * - 引用链接一律指向公开页 /p/<shareCode>（前端 evidenceHref 对带 url 的证据优先使用它）；
 * - source 统一为 knowledge，让前台来源面板按站内知识渲染。
 */
function publicEvidenceUrl(scope: PublicArticleScope, metadata: unknown): string | null {
    const articleId = toId((metadata as { articleId?: string | number } | null)?.articleId ?? null)
    if (articleId == null) return null
    const ref = scope.get(articleId)
    return ref ? buildPublicArticleHref(ref.shareCode) : null
}

function withPublicEvidence(
    normalized: ToolNormalizerResult,
    scope: PublicArticleScope,
): ToolNormalizerResult {
    if (!normalized.evidence || normalized.evidence.length === 0) return normalized
    return {
        ...normalized,
        evidence: normalized.evidence.map((item) => {
            const url = publicEvidenceUrl(scope, item.metadata)
            return {
                ...item,
                source: "knowledge" as const,
                ...(url ? { url } : {}),
            }
        }),
    }
}

/** 公开场景的 legacy 工具上下文：以站点 owner 身份读取其知识库内容。 */
function publicLegacyContext(ctx: ToolExecutionContext) {
    return {
        userId: ctx.userId,
        threadId: ctx.threadId ?? 0,
        runId: ctx.dbRunId ?? 0,
        focus: null,
        systemRole: null,
    }
}

async function executePublicRead(
    ctx: ToolExecutionContext,
    scope: PublicArticleScope,
    input: z.infer<typeof readNodeSchema>,
): Promise<unknown> {
    // 显式传入的寻址参数若直接给出文章 id，先过白名单
    const directArticleId = toId(input.articleId)
    if (directArticleId != null && !scope.has(directArticleId)) {
        throw notFound("该文章不在公开范围内")
    }
    // pageKey 寻址（Wiki 页面）：主题页的 pageKey 不含文章 id，读取结果的
    // articleId 可能为空，无法靠归属校验兜底——先做公开可达性判定。
    if (input.pageKey) {
        await assertPublicWikiPageAccessible(scope, input.pageKey)
    }
    const chunkId = toId(input.chunkId)
    const output = await readKnowledgeNode(publicLegacyContext(ctx), {
        knowledgeBaseId: toId(input.knowledgeBaseId),
        ...(input.nodeKey ? { nodeKey: input.nodeKey } : {}),
        ...(chunkId != null ? { chunkId } : {}),
        ...(input.pageKey ? { pageKey: input.pageKey } : {}),
        ...(directArticleId != null ? { articleId: directArticleId } : {}),
    })
    // 其余寻址方式（chunk/nodeKey/articleId）读取后校验归属：结果只进服务端内存，
    // 校验失败即抛错，内容不会到达模型或用户。
    if (!input.pageKey) {
        const articleId = readOutputArticleId(output)
        if (articleId == null || !scope.has(articleId)) {
            throw notFound("该内容不在公开范围内")
        }
        return output
    }
    // Wiki 页面读取：从 sourceRefs 里找第一篇公开文章，给证据补公开页回链
    const sourceRefIds = (((output as { sourceRefs?: unknown }).sourceRefs as Array<unknown>) ?? [])
        .map((ref) => toId((ref as { articleId?: string | number } | null)?.articleId))
        .filter((id): id is number => id != null)
    const publicRef = sourceRefIds
        .map((id) => scope.get(id))
        .find((ref) => ref != null)
    return {
        ...(output as Record<string, unknown>),
        ...(publicRef ? { publicHref: buildPublicArticleHref(publicRef.shareCode) } : {}),
    }
}

async function executePublicReadBatch(
    ctx: ToolExecutionContext,
    scope: PublicArticleScope,
    nodes: Array<z.infer<typeof readNodeSchema>>,
    limit: number,
): Promise<KnowledgeReadBatchOutput> {
    const selected = nodes.slice(0, limit)
    const settled = await Promise.allSettled(selected.map(async (node) => ({
        requested: node,
        output: await executePublicRead(ctx, scope, node),
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

function normalizeKnowledgeReadForPublic(
    scope: PublicArticleScope,
): (output: unknown, input: unknown) => ToolNormalizerResult {
    return (output, input) => {
        const normalized = withPublicEvidence(normalizeKnowledgeRead(output, input), scope)
        // Wiki 页面读取（pageKey 寻址）：证据带公开页回链（executePublicRead 注入 publicHref）
        const publicHref = (output as { publicHref?: string } | null)?.publicHref
        if (!publicHref || !normalized.evidence?.length) return normalized
        return {
            ...normalized,
            evidence: normalized.evidence.map((item) => ({
                ...item,
                ...(item.url ? {} : { url: publicHref }),
            })),
        }
    }
}

function normalizeKnowledgeReadBatchForPublic(
    scope: PublicArticleScope,
): (output: unknown) => ToolNormalizerResult {
    return (output) => withPublicEvidence(normalizeKnowledgeReadBatch(output), scope)
}

/** 从检索命中里提取去重后的读取请求（对齐后台 uniqueReadRequests 的行为） */
function uniqueReadRequests(hits: Array<Record<string, unknown>>): Array<z.infer<typeof readNodeSchema>> {
    const seen = new Set<string>()
    const nodes: Array<z.infer<typeof readNodeSchema>> = []
    for (const hit of hits) {
        const knowledgeBaseId = toId(hit.knowledgeBaseId as string | number | undefined)
        const base = knowledgeBaseId != null ? { knowledgeBaseId } : {}
        let node: z.infer<typeof readNodeSchema> | null = null
        const chunkId = toId(hit.chunkId as string | number | undefined)
        if (chunkId != null) node = { ...base, chunkId }
        else if (typeof hit.nodeKey === "string" && hit.nodeKey.trim()) node = { ...base, nodeKey: hit.nodeKey.trim() }
        else if (typeof hit.pageKey === "string" && hit.pageKey.trim()) node = { ...base, pageKey: hit.pageKey.trim() }
        else {
            const articleId = toId(hit.articleId as string | number | undefined)
            if (articleId != null) node = { ...base, articleId }
        }
        if (!node) continue
        const key = `${node.knowledgeBaseId ?? ""}:${node.chunkId ?? node.nodeKey ?? node.pageKey ?? node.articleId ?? ""}`
        if (seen.has(key)) continue
        seen.add(key)
        nodes.push(node)
    }
    return nodes
}

export function buildPublicQaAgentTools(scope: PublicArticleScope): AgentToolDefinition[] {
    const searchExecute = async (ctx: ToolExecutionContext, raw: unknown) => {
        const input = searchSchema.parse(raw)
        const limit = input.limit ?? 10
        const rewritten = input.subQueries?.length
            ? { subQueries: input.subQueries, applied: true }
            : rewriteQuery(input.query)

        // 全部检索：站长全库跨库混合召回 → 公开白名单后过滤。
        // 放大召回量再收窄，避免未公开文章占满 top-K 导致公开内容漏召回。
        const result = await recallKnowledgeCandidatesAcrossKbs({
            userId: ctx.userId,
            query: input.query,
            ...(rewritten.subQueries.length ? { subQueries: rewritten.subQueries } : {}),
            limit: Math.min(limit * SEARCH_OVERFETCH_FACTOR, 30),
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        })

        const hits = result.candidates
            .filter((candidate) => scope.has(Number(candidate.articleId)))
            .slice(0, limit)
            .map((candidate) => ({
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
            }))

        return {
            mode: "cross_kb" as const,
            retrievalMode: "hybrid" as const,
            hits,
            // 诊断标记（仅进 Trace/Debug）：本次召回已按公开白名单收窄
            diagnostics: {
                ...result.diagnostics,
                retrievalScope: "cross_kb_public_only",
            },
        }
    }

    const wikiSearchSchema = z.object({
        queries: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
        limit: z.number().int().min(1).max(20).optional(),
    })

    return [
        defineTool({
            id: "knowledge.search",
            name: "search_knowledge",
            namespace: "knowledge",
            core: true,
            riskLevel: "low",
            sideEffect: false,
            description:
                "在本站「已公开的内容」里做全库检索（联合原始分片、分片推荐问题和 Wiki 页面返回候选，不含全文）。"
                + "何时用：需要站内资料支撑结论时，作为第一步定位相关章节或 Wiki 页面。"
                + "输入：query（检索问题）；可选 subQueries 拆分复杂问题。不需要也无法指定知识库——默认检索全部公开内容。"
                + "输出：候选列表，分片含 chunkId，Wiki 含 pageKey。"
                + "何时不用：需要正文时改用 read_knowledge_node。",
            inputSchema: searchSchema,
            execute: searchExecute,
            normalize: normalizeKnowledgeSearch,
        }),

        defineTool({
            id: "knowledge.lookup",
            name: "lookup_knowledge",
            namespace: "knowledge",
            core: true,
            riskLevel: "low",
            sideEffect: false,
            description:
                "一次完成检索并深读最相关的 1~2 个章节，每个章节都会生成独立可追溯来源。"
                + "何时用：简单的定义、功能、用途、用法等知识问答，优先用它减少等待。"
                + "输入：query。不需要也无法指定知识库。"
                + "输出：候选摘要、召回诊断、章节正文与独立证据。"
                + "何时不用：复杂比较或需要自主挑选更多章节时，改用 search_knowledge + read_knowledge_nodes。",
            inputSchema: searchSchema,
            execute: async (ctx, raw) => {
                const input = searchSchema.parse(raw)
                const searchOutput = await searchExecute(ctx, {
                    ...input,
                    limit: input.limit ?? 6,
                })
                const hits = ((searchOutput as { hits?: Array<Record<string, unknown>> }).hits ?? [])
                const nodes = uniqueReadRequests(hits)
                const reads = await executePublicReadBatch(ctx, scope, nodes, 2)
                return {
                    ...(searchOutput as Record<string, unknown>),
                    reads,
                }
            },
            normalize: (output): ToolNormalizerResult => {
                const record = output as {
                    hits?: Array<Record<string, unknown>>
                    diagnostics?: Record<string, unknown>
                    reads?: KnowledgeReadBatchOutput
                }
                const hits = record.hits ?? []
                const readResult = normalizeKnowledgeReadBatchForPublic(scope)(record.reads ?? {
                    items: [],
                    requestedCount: 0,
                    skippedCount: 0,
                })
                const evidence = readResult.evidence ?? []
                const retrieval = retrievalDisplaySummary(
                    record.diagnostics as Parameters<typeof retrievalDisplaySummary>[0],
                )

                if (hits.length === 0) {
                    return {
                        summary: "公开内容中未检索到相关资料",
                        data: { hits: [], readCount: 0 },
                        suggestedActions: ["rewrite_query"],
                    }
                }

                return {
                    progress: true,
                    summary: evidence.length > 0
                        ? `找到 ${hits.length} 个相关章节并深读 ${evidence.length} 个（${retrieval}）`
                        : `找到 ${hits.length} 个候选章节，但没有读到可引用正文（${retrieval}）`,
                    data: {
                        mode: (record as { mode?: string }).mode,
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
                + "输入：nodes 数组，每项均为 chunkId、pageKey、nodeKey、articleId 四选一，并携带该条目所属的 knowledgeBaseId。"
                + "输出：每个章节的正文、层级上下文与独立可追溯证据。"
                + "何时不用：只需读取一个明确章节时用 read_knowledge_node。",
            inputSchema: z.object({
                nodes: z.array(readNodeSchema).min(1).max(4),
            }),
            execute: async (ctx, raw) => {
                const input = z.object({ nodes: z.array(readNodeSchema).min(1).max(4) }).parse(raw)
                const limit = ctx.state.complexity === "simple" ? 2 : 4
                return await executePublicReadBatch(ctx, scope, input.nodes, limit)
            },
            normalize: normalizeKnowledgeReadBatchForPublic(scope),
        }),

        defineTool({
            id: "knowledge.read",
            name: "read_knowledge_node",
            namespace: "knowledge",
            core: true,
            riskLevel: "low",
            sideEffect: false,
            description:
                "读取本站公开内容某个原始分片、Wiki 页面、目录节点或整篇文章的正文。"
                + "何时用：search 定位到候选后，对真正相关的 1~3 条深读。"
                + "输入：chunkId、pageKey、nodeKey、articleId 四选一，并携带检索结果里返回的 knowledgeBaseId。"
                + "输出：正文、面包屑、子节点、媒体引用。"
                + "何时不用：不要把所有候选都读一遍；只需要标题清单时用 search。",
            inputSchema: readNodeSchema,
            execute: async (ctx, raw) => {
                const input = readNodeSchema.parse(raw)
                return await executePublicRead(ctx, scope, input)
            },
            normalize: normalizeKnowledgeReadForPublic(scope),
        }),

        // ---------------------------------------------------------- Wiki 模式
        defineTool({
            id: "knowledge.wiki_overview",
            name: "wiki_overview",
            namespace: "knowledge",
            riskLevel: "low",
            sideEffect: false,
            tags: ["wiki"],
            description:
                "列出本站公开 Wiki 的分组概览：主题与知识页（概念/实体/对比/答案）+ 源文档页，每页含 pageKey、标题与摘要。"
                + "何时用：Wiki 问答的第一步，先掌握全貌再决定读哪些页面。"
                + "输入：无。"
                + "输出：分组页面目录。已知 pageKey 时可直接 read_wiki_page_detail。",
            inputSchema: z.object({}),
            execute: async () => {
                const overview = await listPublicWikiOverview(scope)
                return {
                    ...overview,
                    emptyMessage: overview.total === 0 ? "本站暂无公开的 Wiki 页面" : undefined,
                }
            },
            normalize: normalizeWikiOverview,
        }),

        defineTool({
            id: "knowledge.search_wiki_pages",
            name: "search_wiki_pages",
            namespace: "knowledge",
            riskLevel: "low",
            sideEffect: false,
            tags: ["wiki"],
            description:
                "在公开 Wiki 页面里做多关键词检索：queries 一次传多个词（同义概念、别名词一起搜），"
                + "命中标题/摘要/别名/正文，返回 pageKey、标题、类型、别名、摘要与正文命中片段。"
                + "何时用：不知道确切 pageKey 时定位 Wiki 页面。"
                + "何时不用：要浏览全貌用 wiki_overview；要正文用 read_wiki_page_detail。",
            inputSchema: wikiSearchSchema,
            execute: async (ctx, raw) => {
                const input = wikiSearchSchema.parse(raw)
                return await searchPublicWikiPages({
                    scope,
                    queries: input.queries,
                    limit: input.limit,
                })
            },
            normalize: normalizeWikiSearchPages,
        }),

        defineTool({
            id: "knowledge.read_wiki_page_detail",
            name: "read_wiki_page_detail",
            namespace: "knowledge",
            riskLevel: "low",
            sideEffect: false,
            tags: ["wiki"],
            description:
                "按 pageKey 读取一篇公开 Wiki 页面：全文 Markdown + 关联页面（links/inLinks，各带标题与摘要）+ 来源文章。"
                + "何时用：search_wiki_pages 或 wiki_overview 定位到相关页面后深读。"
                + "输入：pageKey 必填。"
                + "输出：页面全文与关联信息；回答时用 [[pageKey|标题]] 引用该页面。",
            inputSchema: z.object({
                pageKey: z.string().trim().min(1).max(200),
            }),
            execute: async (ctx, raw) => {
                const input = z.object({ pageKey: z.string().trim().min(1).max(200) }).parse(raw)
                return await readPublicWikiPageDetail(scope, input.pageKey)
            },
            // Wiki 页面本身经 [[pageKey|标题]] 内联引用打开；证据条目再带上
            // 来源文章的公开页链接，让引用条里的来源也可点。
            normalize: (output): ToolNormalizerResult => {
                const normalized = withPublicEvidence(normalizeWikiPageDetail(output), scope)
                if (!normalized.evidence?.length) return normalized
                const sourceHref = (output as {
                    sourceArticles?: Array<{ href?: string }>
                }).sourceArticles?.find((item) => typeof item.href === "string" && item.href)?.href
                if (!sourceHref) return normalized
                return {
                    ...normalized,
                    evidence: normalized.evidence.map((item) => ({
                        ...item,
                        ...(item.url ? {} : { url: sourceHref }),
                    })),
                }
            },
        }),
    ]
}
