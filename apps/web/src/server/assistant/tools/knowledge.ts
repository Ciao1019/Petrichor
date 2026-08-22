import { z } from "zod"
import { knowledgeBaseArticlePath, knowledgeBasePath } from "@/lib/dashboard-routes"
import {
    listUserKnowledgeBases,
    readSourceArticleForAgent,
    readWikiPageForAgent,
    searchWikiPagesAcrossKbs,
} from "@/server/kb/wiki-agent-logic"
import {
    readTreeNodeForAgent,
    retrieveTreeNodesForAgent,
    semanticSearchTreeNodes,
    type TreeRetrievalHit,
} from "@/server/kb/wiki-tree"
import { readArticleKnowledgeChunkForAgent } from "@/server/kb/article-knowledge-index"
import { badRequest, notFound } from "@/server/http/response"
import { retrieveFromGraph } from "@/server/site-graph/qa-retrieval"
import { loadPublicSiteGraph } from "@/server/site-graph/public-graph"
import type { AssistantToolContext, AssistantToolRegistration } from "../domain-types"

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const searchKnowledgeGraphSchema = z.object({
    query: z.string().trim().min(1),
    maxHops: z.number().int().min(1).max(3).optional(),
    limit: z.number().int().min(1).max(10).optional(),
})

const searchKnowledgeSchema = z.object({
    query: z.string().trim().min(1),
    knowledgeBaseId: idSchema.optional().nullable(),
    limit: z.number().int().min(1).max(12).optional(),
})

const readKnowledgeNodeSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    nodeKey: z.string().trim().min(1).optional(),
    chunkId: idSchema.optional(),
    pageKey: z.string().trim().min(1).optional(),
    articleId: idSchema.optional(),
}).superRefine((value, ctx) => {
    const addressCount = [value.nodeKey, value.chunkId, value.pageKey, value.articleId]
        .filter((item) => item != null)
        .length
    if (addressCount !== 1) {
        ctx.addIssue({
            code: "custom",
            message: "nodeKey、chunkId、pageKey、articleId 必须且只能提供一个",
        })
    }
})

function focusId(value: string | null | undefined): number | null {
    return value == null ? null : idSchema.parse(value)
}

function toTreeSearchHit(knowledgeBaseId: number, hit: TreeRetrievalHit) {
    return {
        knowledgeBaseId: String(knowledgeBaseId),
        nodeKey: hit.nodeKey,
        articleId: hit.articleId,
        href: knowledgeBaseArticlePath(String(knowledgeBaseId), hit.articleId),
        title: hit.title,
        path: hit.path,
        snippet: hit.contentMd,
    }
}

export async function searchKnowledge(
    ctx: AssistantToolContext,
    input: z.infer<typeof searchKnowledgeSchema>,
) {
    const explicitKnowledgeBaseId = input.knowledgeBaseId ?? null
    const knowledgeBaseId = explicitKnowledgeBaseId ?? focusId(ctx.focus?.knowledgeBaseId)
    const limit = input.limit ?? 8

    if (knowledgeBaseId == null) {
        const hits = await searchWikiPagesAcrossKbs({
            userId: ctx.userId,
            query: input.query,
            limit,
        })
        return {
            mode: "cross_kb" as const,
            hits: hits.map((hit) => ({
                knowledgeBaseId: hit.knowledgeBaseId,
                knowledgeBaseName: hit.knowledgeBaseName,
                pageKey: hit.pageKey,
                articleId: hit.articleId,
                href: hit.href ?? knowledgeBasePath(hit.knowledgeBaseId),
                title: hit.title,
                snippet: hit.summary,
            })),
        }
    }

    const articleId = explicitKnowledgeBaseId == null ? focusId(ctx.focus?.articleId) ?? undefined : undefined
    const treeHits = await retrieveTreeNodesForAgent({
        userId: ctx.userId,
        knowledgeBaseId,
        query: input.query,
        limit,
        articleId,
        maxContentChars: 1600,
    })
    let semanticAvailable = true
    let semanticHits: TreeRetrievalHit[] = []
    try {
        semanticHits = await semanticSearchTreeNodes({
            userId: ctx.userId,
            knowledgeBaseId,
            query: input.query,
            limit,
            articleId,
            maxContentChars: 1600,
        })
    } catch {
        semanticAvailable = false
    }

    const mergedHits = new Map<string, ReturnType<typeof toTreeSearchHit>>()
    for (const hit of [...treeHits, ...semanticHits]) {
        if (!mergedHits.has(hit.nodeKey)) {
            mergedHits.set(hit.nodeKey, toTreeSearchHit(knowledgeBaseId, hit))
        }
    }

    const owned = await listUserKnowledgeBases(ctx.userId)
    const knowledgeBaseName = owned.find((item) => item.id === String(knowledgeBaseId))?.name ?? null

    return {
        mode: semanticAvailable ? "tree+semantic" as const : "tree" as const,
        knowledgeBaseId: String(knowledgeBaseId),
        knowledgeBaseName,
        hits: Array.from(mergedHits.values()).slice(0, limit),
    }
}

export async function readKnowledgeNode(
    ctx: AssistantToolContext,
    input: z.infer<typeof readKnowledgeNodeSchema>,
) {
    const knowledgeBaseId = input.knowledgeBaseId ?? focusId(ctx.focus?.knowledgeBaseId)
    if (knowledgeBaseId == null) {
        // 跨库检索（search_knowledge 不传 knowledgeBaseId）时没有 focus 默认库，
        // 必须由调用方把命中项里的 knowledgeBaseId 带回来。报错要给出可执行的下一步，
        // 否则模型只会当成「工具不可用」直接放弃。
        throw badRequest(
            "缺少 knowledgeBaseId：当前对话没有默认知识库。请从 search_knowledge 返回的 hits[].knowledgeBaseId 取出该条目所属的库 ID，连同 nodeKey/pageKey/articleId 一起重新调用本工具。",
        )
    }

    if (input.nodeKey) {
        const node = await readTreeNodeForAgent(ctx.userId, knowledgeBaseId, input.nodeKey)
        if (!node) throw notFound("目录节点不存在")
        return {
            kind: "tree_node" as const,
            ...node,
            href: knowledgeBaseArticlePath(String(knowledgeBaseId), node.articleId),
        }
    }
    if (input.chunkId != null) {
        return await readArticleKnowledgeChunkForAgent(ctx.userId, knowledgeBaseId, input.chunkId)
    }
    if (input.pageKey) {
        const page = await readWikiPageForAgent(ctx.userId, knowledgeBaseId, input.pageKey)
        const { kind: pageKind, ...rest } = page
        return {
            kind: "wiki_page" as const,
            pageKind,
            ...rest,
            href: page.href ?? knowledgeBasePath(String(knowledgeBaseId)),
        }
    }
    if (input.articleId != null) {
        return {
            kind: "article" as const,
            ...await readSourceArticleForAgent(ctx.userId, knowledgeBaseId, input.articleId),
        }
    }

    throw badRequest("缺少知识节点寻址参数")
}

export const knowledgeAssistantTools: AssistantToolRegistration[] = [
    {
        name: "list_knowledge_bases",
        domain: "knowledge",
        risk: "read",
        description: "列出当前登录用户拥有的知识库，用于选择检索范围或回答知识库概览问题。",
        inputSchema: z.object({}),
        execute: async (ctx, input) => {
            z.object({}).parse(input)
            return await listUserKnowledgeBases(ctx.userId)
        },
    },
    {
        name: "search_knowledge",
        domain: "knowledge",
        risk: "read",
        description: "检索知识内容：有 knowledgeBaseId（或 focus 默认库）时组合树检索与语义检索；无库范围时跨知识库模糊检索（支持中文近邻标题，不必精确全名）。计数/清单类问题请用 list_system_overview 或 list_knowledge_bases，不要对每个库重复同类 search；跨库内容检索优先一次不传 knowledgeBaseId。",
        inputSchema: searchKnowledgeSchema,
        execute: async (ctx, input) => await searchKnowledge(ctx, searchKnowledgeSchema.parse(input)),
    },
    {
        name: "search_knowledge_graph",
        domain: "knowledge",
        risk: "read",
        // 注意作用域：全站星图只由「已公开分享的文章」构建，覆盖不到私有知识库。
        // 因此它是关系型问题的加速入口，不能替代 search_knowledge。
        description: "在「全站星图」（知识图谱）上按问题检索：把问句落到概念/实体节点，沿关系边扩散，返回命中概念、途经链路与链路终点的文章。适合「A 和 B 有什么关系 / 围绕某概念都写过什么」这类关联型问题。注意：星图仅覆盖已公开分享的文章，查不到私有知识库内容，因此它只是加速入口——私有内容或图谱未命中时，仍需用 search_knowledge。返回的 articles[].articleId 可继续传给 read_knowledge_node。",
        inputSchema: searchKnowledgeGraphSchema,
        execute: async (ctx, input) => {
            void ctx
            const parsed = searchKnowledgeGraphSchema.parse(input)
            const payload = await loadPublicSiteGraph()
            return retrieveFromGraph(payload, parsed)
        },
    },
    {
        name: "read_knowledge_node",
        domain: "knowledge",
        risk: "read",
        description: "读取检索命中的知识内容；chunkId、pageKey、nodeKey、articleId 四选一。分片/问题召回优先使用 chunkId 读取原始分片，Wiki 命中使用 pageKey；knowledgeBaseId 仅在当前对话已锁定知识库时可省略。Wiki/存量节点若含图片或附件会返回 media。",
        inputSchema: readKnowledgeNodeSchema,
        execute: async (ctx, input) => await readKnowledgeNode(ctx, readKnowledgeNodeSchema.parse(input)),
    },
]
