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
import { badRequest, notFound } from "@/server/http/response"
import type { AssistantToolContext, AssistantToolRegistration } from "../domain-types"

const idSchema = z.union([z.string(), z.number()]).transform((value, ctx) => {
    const raw = String(value).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        ctx.addIssue({ code: "custom", message: "ID 必须是正整数" })
        return z.NEVER
    }
    return Number(raw)
})

const searchKnowledgeSchema = z.object({
    query: z.string().trim().min(1),
    knowledgeBaseId: idSchema.optional().nullable(),
    limit: z.number().int().min(1).max(12).optional(),
})

const readKnowledgeNodeSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    nodeKey: z.string().trim().min(1).optional(),
    pageKey: z.string().trim().min(1).optional(),
    articleId: idSchema.optional(),
}).superRefine((value, ctx) => {
    const addressCount = [value.nodeKey, value.pageKey, value.articleId]
        .filter((item) => item != null)
        .length
    if (addressCount !== 1) {
        ctx.addIssue({
            code: "custom",
            message: "nodeKey、pageKey、articleId 必须且只能提供一个",
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

    return {
        mode: semanticAvailable ? "tree+semantic" as const : "tree" as const,
        knowledgeBaseId: String(knowledgeBaseId),
        hits: Array.from(mergedHits.values()).slice(0, limit),
    }
}

export async function readKnowledgeNode(
    ctx: AssistantToolContext,
    input: z.infer<typeof readKnowledgeNodeSchema>,
) {
    const knowledgeBaseId = input.knowledgeBaseId ?? focusId(ctx.focus?.knowledgeBaseId)
    if (knowledgeBaseId == null) {
        throw badRequest("缺少 knowledgeBaseId，且当前对话未提供 focus.knowledgeBaseId")
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
        description: "检索知识内容：有 knowledgeBaseId（或 focus 默认库）时组合树检索与语义检索；无库范围时跨知识库模糊检索（支持中文近邻标题，不必精确全名）。",
        inputSchema: searchKnowledgeSchema,
        execute: async (ctx, input) => await searchKnowledge(ctx, searchKnowledgeSchema.parse(input)),
    },
    {
        name: "read_knowledge_node",
        domain: "knowledge",
        risk: "read",
        description: "读取检索命中的知识内容；nodeKey、pageKey、articleId 三选一，可省略 knowledgeBaseId 使用 focus 默认库。若内容含图片/附件，会在 media 字段返回可直接渲染的引用（src 多为 s4key:…）；需要展示图片时在最终答案中输出 Markdown：`![说明](media.src)`。",
        inputSchema: readKnowledgeNodeSchema,
        execute: async (ctx, input) => await readKnowledgeNode(ctx, readKnowledgeNodeSchema.parse(input)),
    },
]
