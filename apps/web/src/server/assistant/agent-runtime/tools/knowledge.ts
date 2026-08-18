import { z } from "zod"
import { knowledgeBaseArticlePath, knowledgeBasePath } from "@/lib/dashboard-routes"
import {
    recallKnowledgeCandidates,
    recallKnowledgeCandidatesAcrossKbs,
} from "@/server/kb/knowledge-recall"
import { listUserKnowledgeBases, readSourceArticleForAgent, searchWikiPagesAcrossKbs } from "@/server/kb/wiki-agent-logic"
import { rewriteQuery } from "@/server/retrieval/query-rewrite"
import { readKnowledgeNode } from "../../tools/knowledge"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolNormalizerResult } from "../types"

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
    pageKey: z.string().trim().min(1).optional(),
    articleId: idSchema.optional(),
}).superRefine((value, ctx) => {
    const count = [value.nodeKey, value.pageKey, value.articleId].filter((item) => item != null).length
    if (count !== 1) {
        ctx.addIssue({ code: "custom", message: "nodeKey、pageKey、articleId 必须且只能提供一个" })
    }
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

export const knowledgeTools: AgentToolDefinition[] = [
    defineTool({
        id: "knowledge.search",
        name: "search_knowledge",
        namespace: "knowledge",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "检索站内知识库，返回候选章节列表（不含全文）。"
            + "何时用：需要站内资料支撑结论时，作为第一步定位相关章节。"
            + "输入：query（检索问题）；可选 knowledgeBaseId 限定库、subQueries 拆分复杂问题。"
            + "输出：候选列表，含 nodeKey / 标题 / 路径 / 摘要 / 命中来源 / 相关度。"
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
                            nodeKey: candidate.nodeKey,
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
                    nodeKey: candidate.nodeKey,
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
                diagnostics?: { degraded?: Record<string, string> }
            }
            const hits = record.hits ?? []
            if (hits.length === 0) {
                return {
                    summary: "知识库中未检索到相关内容",
                    data: { hits: [] },
                    suggestedActions: ["rewrite_query", "load_skill:research"],
                }
            }
            const degraded = Object.keys(record.diagnostics?.degraded ?? {})
            return {
                // 找到候选就是进展：正文要靠 knowledge.read 才有证据（§31）
                progress: true,
                summary: `找到 ${hits.length} 个相关知识节点`
                    + (degraded.length ? `（${degraded.join("/")} 召回暂不可用）` : ""),
                // 只回传定位信息，正文交给 read（§30）
                data: {
                    mode: record.mode,
                    hits: hits.map((hit) => ({
                        nodeKey: hit.nodeKey,
                        pageKey: hit.pageKey,
                        articleId: hit.articleId,
                        knowledgeBaseId: hit.knowledgeBaseId,
                        title: hit.title,
                        path: hit.path,
                        summary: hit.summary,
                        recallSources: hit.recallSources,
                    })),
                },
                suggestedActions: ["knowledge.read"],
            }
        },
    }),

    defineTool({
        id: "knowledge.read",
        name: "read_knowledge_node",
        namespace: "knowledge",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        description:
            "读取知识库某个节点/页面/文章的正文。"
            + "何时用：search 定位到候选后，对真正相关的 1~3 条深读。"
            + "输入：nodeKey、pageKey、articleId 三选一；跨库检索命中的条目必须带上其 knowledgeBaseId。"
            + "输出：正文、面包屑、子节点、媒体引用。"
            + "何时不用：不要把所有候选都读一遍；只需要标题清单时用 search。",
        inputSchema: readSchema,
        execute: async (ctx, raw) => {
            const input = readSchema.parse(raw)
            const legacyCtx = {
                userId: ctx.userId,
                threadId: ctx.threadId ?? 0,
                runId: ctx.dbRunId ?? 0,
                focus: (ctx.focus ?? null) as never,
                systemRole: ctx.systemRole ?? null,
            }
            const node = await readKnowledgeNode(legacyCtx, input as never) as Record<string, unknown>

            // 结构性节点（如首个标题之前的根节点）自身没有正文，直接返回等于白读一次。
            // 这类节点的内容在整篇文章里，回退到文章正文，保证 read 一定能产出证据。
            const content = typeof node.contentMd === "string" ? node.contentMd.trim() : ""
            if (content.length > 0) return node

            const knowledgeBaseId = Number(node.knowledgeBaseId ?? input.knowledgeBaseId ?? focusKnowledgeBaseId(ctx.focus))
            const articleId = Number(node.articleId)
            if (!Number.isInteger(knowledgeBaseId) || !Number.isInteger(articleId) || articleId <= 0) return node

            const article = await readSourceArticleForAgent(ctx.userId, knowledgeBaseId, articleId)
            return {
                ...node,
                contentMd: article.contentMd,
                // 说明正文来自整篇文章，避免模型误以为这一节就这么长
                contentFrom: "article" as const,
                articleTitle: article.title,
            }
        },
        normalize: (output, input): ToolNormalizerResult => {
            const record = output as {
                kind?: string
                title?: string
                articleTitle?: string
                nodeKey?: string
                articleId?: string
                knowledgeBaseId?: string
                path?: string
                contentMd?: string
                content?: string
                breadcrumb?: string[]
            }
            const title = record.title ?? record.articleTitle ?? "知识节点"
            const content = (record.contentMd ?? record.content ?? "").trim()
            const path = record.breadcrumb ?? (record.path ? String(record.path).split(" / ").filter(Boolean) : undefined)

            const fromArticle = (output as { contentFrom?: string }).contentFrom === "article"
            return {
                summary: content
                    ? `已读取「${title}」（${content.length} 字${fromArticle ? "，该节点无独立正文，已取整篇文章" : ""}）`
                    : `「${title}」没有正文内容`,
                data: {
                    kind: record.kind,
                    title,
                    nodeKey: record.nodeKey,
                    articleId: record.articleId,
                    // 正文进证据，不重复进 observation data
                    excerpt: content.slice(0, 400),
                },
                evidence: content
                    ? [{
                        source: "knowledge",
                        title,
                        content: content.slice(0, 4_000),
                        ...(record.nodeKey ? { sourceId: record.nodeKey } : {}),
                        relevance: 0.8,
                        confidence: 0.8,
                        metadata: {
                            ...(record.nodeKey ? { nodeKey: record.nodeKey } : {}),
                            ...(record.articleId ? { articleId: String(record.articleId) } : {}),
                            ...(record.knowledgeBaseId ? { knowledgeBaseId: String(record.knowledgeBaseId) } : {}),
                            ...(path ? { path } : {}),
                            requestedBy: input,
                        },
                    }]
                    : [],
            }
        },
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
