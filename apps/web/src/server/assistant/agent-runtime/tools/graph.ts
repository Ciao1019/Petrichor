import { z } from "zod"
import { loadPublicSiteGraph } from "@/server/site-graph/public-graph"
import { retrieveFromGraph, type GraphRetrievalResult } from "@/server/site-graph/qa-retrieval"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolNormalizerResult } from "../types"

/**
 * 知识图谱能力（§35/§36/§98）。
 *
 * 作用域限制：全站星图只由「已公开分享的文章」构建，覆盖不到私有知识库。
 * 因此图谱是关系型问题的加速入口，不替代 knowledge.search。
 */

const searchSchema = z.object({
    query: z.string().trim().min(1).max(200),
    maxHops: z.number().int().min(1).max(3).optional(),
    limit: z.number().int().min(1).max(10).optional(),
})

const expandSchema = z.object({
    entity: z.string().trim().min(1).max(120).describe("要扩散的实体名或概念名"),
    maxHops: z.number().int().min(1).max(3).optional(),
    limit: z.number().int().min(1).max(20).optional(),
})

const entitySchema = z.object({
    entity: z.string().trim().min(1).max(120),
})

async function queryGraph(query: string, maxHops?: number, limit?: number): Promise<GraphRetrievalResult> {
    const payload = await loadPublicSiteGraph()
    return retrieveFromGraph(payload, {
        query,
        ...(maxHops != null ? { maxHops } : {}),
        ...(limit != null ? { limit } : {}),
    })
}

function graphNormalizer(kind: string) {
    return (output: unknown): ToolNormalizerResult => {
        const result = output as GraphRetrievalResult
        const matched = result?.matched ?? []
        const articles = result?.articles ?? []
        if (matched.length === 0) {
            return {
                summary: "知识图谱中未命中相关实体",
                data: { matched: [], articles: [] },
                suggestedActions: ["knowledge.search"],
            }
        }
        return {
            progress: true,
            summary: `图谱命中 ${matched.length} 个实体，关联 ${articles.length} 篇文章`,
            data: {
                matched: matched.map((item) => ({ id: item.id, label: item.label, kind: item.kind })),
                paths: (result.paths ?? []).slice(0, 8).map((path) => ({
                    nodes: path.nodes.map((node) => node.label),
                    relations: path.relations,
                })),
                articles: articles.map((article) => ({
                    articleId: article.articleId,
                    title: article.title,
                    viaConcepts: article.viaConcepts,
                })),
            },
            suggestedActions: articles.length > 0 ? ["knowledge.read"] : ["knowledge.search"],
            evidence: matched.slice(0, 5).map((item) => ({
                source: "graph" as const,
                title: item.label,
                content: item.summary || `${item.label}（${item.kind}）`,
                sourceId: item.id,
                relevance: 0.6,
                confidence: 0.7,
                metadata: { kind: item.kind, graphOp: kind, ...(item.route ? { route: item.route } : {}) },
            })),
        }
    }
}

export const graphTools: AgentToolDefinition[] = [
    defineTool({
        id: "graph.search",
        name: "search_knowledge_graph",
        namespace: "graph",
        riskLevel: "low",
        sideEffect: false,
        description:
            "在全站知识图谱上按问题检索：把问句落到概念/实体节点，沿关系边扩散，返回命中实体、途经链路与终点文章。"
            + "何时用：「A 和 B 有什么关系」「围绕某概念都写过什么」这类关联型问题。"
            + "输入：query，可选 maxHops/limit。输出：命中实体、链路、关联文章。"
            + "何时不用：图谱只覆盖已公开分享的文章，查私有知识库内容要用 search_knowledge。",
        inputSchema: searchSchema,
        execute: async (_ctx, raw) => {
            const input = searchSchema.parse(raw)
            return await queryGraph(input.query, input.maxHops, input.limit)
        },
        normalize: graphNormalizer("search"),
    }),

    defineTool({
        id: "graph.expand",
        name: "expand_knowledge_graph",
        namespace: "graph",
        riskLevel: "low",
        sideEffect: false,
        description:
            "从一个已知实体出发扩散，找出它的关联实体与关联文章。"
            + "何时用：已经知道某个实体名，想看它依赖了什么、被什么引用。"
            + "输入：entity（实体名），可选 maxHops/limit。输出：邻接实体、关系链路、关联文章。"
            + "何时不用：还不知道实体名时先用 search_knowledge_graph。",
        inputSchema: expandSchema,
        execute: async (_ctx, raw) => {
            const input = expandSchema.parse(raw)
            return await queryGraph(input.entity, input.maxHops ?? 2, input.limit)
        },
        normalize: graphNormalizer("expand"),
    }),

    defineTool({
        id: "graph.get_entity",
        name: "get_graph_entity",
        namespace: "graph",
        riskLevel: "low",
        sideEffect: false,
        description:
            "读取单个实体在图谱中的基本信息（类型、摘要、属性、站内路径）。"
            + "何时用：需要确认某个实体到底是什么。"
            + "输入：entity。输出：实体详情。"
            + "何时不用：需要关系时用 expand_knowledge_graph。",
        inputSchema: entitySchema,
        execute: async (_ctx, raw) => {
            const input = entitySchema.parse(raw)
            const result = await queryGraph(input.entity, 1, 3)
            return { entity: input.entity, matched: result.matched, emptyMessage: result.emptyMessage }
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as { entity: string; matched?: GraphRetrievalResult["matched"] }
            const matched = record.matched ?? []
            if (matched.length === 0) {
                return { summary: `图谱中没有找到实体「${record.entity}」`, suggestedActions: ["knowledge.search"] }
            }
            const top = matched[0]
            return {
                summary: `实体「${top.label}」（${top.kind}）`,
                data: { entity: top },
                evidence: [{
                    source: "graph",
                    title: top.label,
                    content: top.summary || top.label,
                    sourceId: top.id,
                    relevance: 0.7,
                    confidence: 0.7,
                    metadata: { kind: top.kind },
                }],
            }
        },
    }),

    defineTool({
        id: "graph.get_relations",
        name: "get_graph_relations",
        namespace: "graph",
        riskLevel: "low",
        sideEffect: false,
        description:
            "读取某个实体的关系边列表（它指向谁、谁指向它、关系名是什么）。"
            + "何时用：需要罗列依赖关系、引用关系时。"
            + "输入：entity。输出：关系边与对端实体。"
            + "何时不用：需要正文时改用 knowledge.read。",
        inputSchema: entitySchema,
        execute: async (_ctx, raw) => {
            const input = entitySchema.parse(raw)
            const result = await queryGraph(input.entity, 1, 5)
            return { entity: input.entity, links: result.links, nodes: result.nodes }
        },
        normalize: (output): ToolNormalizerResult => {
            const record = output as { entity: string; links?: GraphRetrievalResult["links"]; nodes?: GraphRetrievalResult["nodes"] }
            const links = record.links ?? []
            const labels = new Map((record.nodes ?? []).map((node) => [node.id, node.label]))
            return {
                summary: links.length === 0
                    ? `实体「${record.entity}」没有可见的关系边`
                    : `实体「${record.entity}」有 ${links.length} 条关系`,
                data: {
                    relations: links.slice(0, 30).map((link) => ({
                        from: labels.get(link.source) ?? link.source,
                        to: labels.get(link.target) ?? link.target,
                        relation: link.relation,
                    })),
                },
            }
        },
    }),
]
