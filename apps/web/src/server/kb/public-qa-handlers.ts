import type { AppRequest } from "@/server/http/request"
import {
    convertToModelMessages,
    createUIMessageStreamResponse,
    isStepCount,
    streamText,
    toUIMessageStream,
    tool,
    type UIMessage,
} from "ai"
import { z } from "zod"
import { createChatLanguageModel } from "@/server/ai/generation"
import { badRequest, forbidden, toErrorResponse } from "@/server/http/response"
import { loadCachedPublicSiteAppearance } from "@/server/appearance/public-loader"
import {
    consumePublicQaQuota,
    resolveClientIp,
    resolveVisitorId,
} from "@/server/kb/public-qa-rate-limit"
import {
    getSiteOwnerUserId,
    listPublicArticles,
    loadPublicArticleScope,
    readPublicSourceArticle,
    readPublicTreeNode,
    readPublicWikiPage,
    retrievePublicTreeNodes,
    searchPublicArticles,
    type PublicArticleScope,
} from "@/server/kb/public-qa-logic"
import {
    listPublicWikiOverview,
    readPublicWikiPageDetail,
    searchPublicWikiPages,
} from "@/server/kb/public-wiki-qa"
import { retrieveFromGraph } from "@/server/site-graph/qa-retrieval"
import { loadPublicSiteGraph } from "@/server/site-graph/public-graph"

/** 前台问答模式：normal 走文章/目录树链路；wiki 参考 WeKnora 的 Wiki 检索链路。 */
type PublicQaMode = "normal" | "wiki"

function resolveQaMode(request: AppRequest): PublicQaMode {
    return request.headers.get("x-petrichor-qa-mode") === "wiki" ? "wiki" : "normal"
}

export const maxDuration = 300

const chatRequestSchema = z.object({
    messages: z.array(z.unknown()).min(1),
})

const idSchema = z.union([z.string(), z.number()]).transform((value) => Number(value)).pipe(
    z.number().int().positive(),
)

const planToolSchema = z.object({
    title: z.string().min(1).default("执行计划"),
    description: z.string().optional(),
    todos: z.array(z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
        description: z.string().optional(),
    })).min(1),
})

const progressToolSchema = z.object({
    title: z.string().min(1).default("执行进度"),
    description: z.string().optional(),
    steps: z.array(z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
        status: z.enum(["pending", "in-progress", "completed", "failed"]),
    })).min(1),
})

const citationToolSchema = z.object({
    citations: z.array(z.object({
        id: z.string().min(1),
        href: z.string().min(1),
        title: z.string(),
        snippet: z.string().optional(),
        domain: z.string().optional(),
        type: z.enum(["webpage", "document", "article", "wiki", "api", "code", "other"]).optional(),
    })).min(1),
})

const dataTableToolSchema = z.object({
    title: z.string().optional(),
    columns: z.array(z.object({
        key: z.string(),
        label: z.string(),
        sortable: z.boolean().optional(),
        format: z.unknown().optional(),
    })).min(1),
    data: z.array(z.record(z.string(), z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    ]))).default([]),
})

export async function publicQaChat(request: AppRequest) {
    try {
        const appearance = await loadCachedPublicSiteAppearance()
        if (!appearance.publicQaEnabled) {
            throw forbidden("站长已关闭前台问答功能")
        }

        const input = chatRequestSchema.parse(await request.json())

        // 限流：visitor-id 主键（10/h）+ IP 兜底（60/h）。
        const quota = await consumePublicQaQuota({
            visitorId: resolveVisitorId(request),
            ip: resolveClientIp(request),
        })

        const ownerUserId = await getSiteOwnerUserId()
        if (ownerUserId == null) {
            throw badRequest("公开问答暂不可用：站点尚未初始化站长账号")
        }

        const { model } = await createChatLanguageModel({ userId: ownerUserId, modelRefId: null })
        const scope = await loadPublicArticleScope()
        const mode = resolveQaMode(request)
        const tools = mode === "wiki"
            ? buildWikiQaTools(scope)
            : buildPublicQaTools(scope)

        const result = streamText({
            model,
            instructions: mode === "wiki" ? buildWikiQaSystemPrompt() : buildPublicQaSystemPrompt(),
            messages: await convertToModelMessages(input.messages as UIMessage[]),
            tools,
            stopWhen: isStepCount(8),
            temperature: 0.2,
        })

        return createUIMessageStreamResponse({
            stream: toUIMessageStream({
                stream: result.stream,
                tools,
            }),
            headers: {
                "X-Petrichor-Qa-Remaining": String(quota.remaining),
                "X-Petrichor-Qa-Limit": String(quota.limit),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

function buildPublicQaTools(scope: PublicArticleScope) {
    return {
        show_agent_plan: tool({
            description: "当问题需要多步检索、阅读、分析时，先展示清晰执行计划。",
            inputSchema: planToolSchema,
            execute: async (input) => ({
                id: `plan-${Date.now()}`,
                title: input.title,
                description: input.description,
                todos: input.todos,
            }),
        }),
        show_progress: tool({
            description: "展示当前检索、阅读、分析的执行进度。",
            inputSchema: progressToolSchema,
            execute: async (input) => ({
                id: `progress-${Date.now()}`,
                title: input.title,
                description: input.description,
                steps: input.steps,
            }),
        }),
        list_public_articles: tool({
            description: "列出本站全部「公开可访问」文章（永久分享、未过期、无密码），含 articleId、shareCode、标题、摘要与公开页链接。用于「有哪些公开文章 / 公开文章目录」类问题；带关键词查内容请用 search_public_articles。",
            inputSchema: z.object({
                limit: z.number().int().min(1).max(50).optional(),
                offset: z.number().int().min(0).optional(),
            }),
            execute: async ({ limit, offset }) => {
                const result = await listPublicArticles({ limit, offset })
                return {
                    ...result,
                    emptyMessage: result.total === 0 ? "本站暂无公开文章" : undefined,
                }
            },
        }),
        search_knowledge_graph: tool({
            description: "在本站「全站星图」（知识图谱）上按问题检索：把问句落到概念/实体节点，沿关系边扩散，返回命中的概念、途经链路与链路终点的公开文章。适合「A 和 B 有什么关系 / 围绕某概念都写过什么 / 这个概念涉及哪些文章」这类关联型问题。返回的 articles 可直接拿 articleId 继续调用 search_document_tree / read_source_article。",
            inputSchema: z.object({
                query: z.string().min(1),
                maxHops: z.number().int().min(1).max(3).optional(),
                limit: z.number().int().min(1).max(10).optional(),
            }),
            execute: async ({ query, maxHops, limit }) => {
                const payload = await loadPublicSiteGraph()
                return retrieveFromGraph(payload, { query, maxHops, limit })
            },
        }),
        search_public_articles: tool({
            description: "在本站「公开文章」里按关键词检索（标题/摘要/正文），返回最相关的文章列表（含 articleId、shareCode、标题、摘要）。回答具体内容问题前优先调用。",
            inputSchema: z.object({
                query: z.string().min(1),
                limit: z.number().int().min(1).max(20).optional(),
            }),
            execute: async ({ query, limit }) => {
                const items = await searchPublicArticles({ query, limit })
                return { query, items, emptyMessage: "没有匹配的公开文章" }
            },
        }),
        search_document_tree: tool({
            description: "推理式检索：在某一篇公开文章的目录树上按问题导航，返回最相关的章节（含 nodeKey、面包屑路径、摘要、原文片段）。必须先用 search_public_articles 拿到 articleId 再调用。",
            inputSchema: z.object({
                articleId: idSchema,
                query: z.string().min(1),
                limit: z.number().int().min(1).max(12).optional(),
            }),
            execute: async ({ articleId, query, limit }) => await retrievePublicTreeNodes({
                scope,
                articleId,
                query,
                limit,
            }),
        }),
        read_tree_node: tool({
            description: "读取目录树中某个章节节点的完整内容（含面包屑路径、子节点与媒体引用）。当 search_document_tree 返回片段被截断、需要看全文时使用，传 nodeKey。",
            inputSchema: z.object({
                nodeKey: z.string().min(1),
            }),
            execute: async ({ nodeKey }) => await readPublicTreeNode(scope, nodeKey),
        }),
        read_wiki_page: tool({
            description: "读取一篇公开文章的 Wiki 页面（pageKey 形如 source-<articleId>）。用于获得可引用、可回答的中间知识；含图片/视频/音频/附件时会在 media 字段返回媒体引用。",
            inputSchema: z.object({
                pageKey: z.string().min(1),
            }),
            execute: async ({ pageKey }) => await readPublicWikiPage(scope, pageKey),
        }),
        read_source_article: tool({
            description: "读取一篇公开文章的源文档全文（含 href 与媒体引用）。当 Wiki 与目录树不足以回答、需要核验原文或查看图片时使用，传 articleId。",
            inputSchema: z.object({
                articleId: idSchema,
            }),
            execute: async ({ articleId }) => await readPublicSourceArticle(scope, articleId),
        }),
        show_citations: tool({
            description: "把最终答案使用的公开文章引用渲染为引用卡片。href 必须用文章公开页路径 `/p/<shareCode>`，title 写文章标题。",
            inputSchema: citationToolSchema,
            execute: async ({ citations }) => ({
                id: `citations-${Date.now()}`,
                citations,
                variant: "default" as const,
            }),
        }),
        show_data_table: tool({
            description: "当答案包含结构化对比、清单或矩阵时渲染为表格。",
            inputSchema: dataTableToolSchema,
            execute: async ({ columns, data, title }) => ({
                id: `table-${Date.now()}`,
                title,
                columns,
                data,
                emptyMessage: "暂无数据",
            }),
        }),
    }
}

function buildWikiQaTools(scope: PublicArticleScope) {
    return {
        show_agent_plan: tool({
            description: "当问题需要多步检索、阅读、分析时，先展示清晰执行计划。",
            inputSchema: planToolSchema,
            execute: async (input) => ({
                id: `plan-${Date.now()}`,
                title: input.title,
                description: input.description,
                todos: input.todos,
            }),
        }),
        show_progress: tool({
            description: "展示当前检索、阅读、分析的执行进度。",
            inputSchema: progressToolSchema,
            execute: async (input) => ({
                id: `progress-${Date.now()}`,
                title: input.title,
                description: input.description,
                steps: input.steps,
            }),
        }),
        wiki_overview: tool({
            description: "列出本站公开 Wiki 的全部分组概览：主题与知识页（概念/实体/对比/答案）+ 源文档页，每页含 pageKey、标题与摘要。回答任何问题前先读它掌握全貌；已知 pageKey 时直接用 read_wiki_page_detail。",
            inputSchema: z.object({}),
            execute: async () => {
                const overview = await listPublicWikiOverview(scope)
                return {
                    ...overview,
                    emptyMessage: overview.total === 0 ? "本站暂无公开的 Wiki 页面" : undefined,
                }
            },
        }),
        search_wiki_pages: tool({
            description: "在公开 Wiki 页面里做多关键词检索：queries 一次可传多个词（同义概念、别名词都搜），命中标题/摘要/别名/正文，返回 pageKey、标题、类型、别名、摘要与正文命中片段。不知道确切 pageKey 时用它定位页面。",
            inputSchema: z.object({
                queries: z.array(z.string().min(1)).min(1).max(6),
                limit: z.number().int().min(1).max(20).optional(),
            }),
            execute: async ({ queries, limit }) => {
                const result = await searchPublicWikiPages({ scope, queries, limit })
                return { ...result, emptyMessage: "没有匹配的 Wiki 页面，试试换个关键词或用 wiki_overview 浏览目录" }
            },
        }),
        read_wiki_page_detail: tool({
            description: "按 pageKey 读取一篇 Wiki 页面：全文 Markdown + 关联页面（links/inLinks，各带标题与摘要）+ 来源文章。回答时优先依据页面内容；关联页面相关时可继续读取或在答案中引用。",
            inputSchema: z.object({
                pageKey: z.string().min(1),
            }),
            execute: async ({ pageKey }) => await readPublicWikiPageDetail(scope, pageKey),
        }),
        show_citations: tool({
            description: "把最终答案使用的来源渲染为引用卡片。Wiki 页面引用写 href 为 `#wiki-page=<pageKey>`、type 为 \"wiki\"；来源文章引用 href 用公开页路径 `/p/<shareCode>`。",
            inputSchema: citationToolSchema,
            execute: async ({ citations }) => ({
                id: `citations-${Date.now()}`,
                citations,
                variant: "default" as const,
            }),
        }),
        show_data_table: tool({
            description: "当答案包含结构化对比、清单或矩阵时渲染为表格。",
            inputSchema: dataTableToolSchema,
            execute: async ({ columns, data, title }) => ({
                id: `table-${Date.now()}`,
                title,
                columns,
                data,
                emptyMessage: "暂无数据",
            }),
        }),
    }
}

function buildWikiQaSystemPrompt() {
    return [
        "你是本站的公开 Wiki 问答助手，面向未登录的访客，知识范围严格限定在本站「公开 Wiki 页面」之内。",
        "检索策略（参考 WeKnora 的 Wiki 检索）：",
        "1. 回答任何内容型问题前，先调用 wiki_overview 掌握 Wiki 全貌（分组目录：主题与知识页 / 源文档页）。",
        "2. 定位具体页面时用 search_wiki_pages：queries 数组一次传多个关键词（把问题拆成同义概念、别名词一起搜），比单关键词效果更好；从返回的 pageKey、摘要与命中片段判断哪些页面最相关。",
        "3. 对最相关的页面调用 read_wiki_page_detail 读全文；返回里的 links/inLinks 是关联页面（带摘要），若与问题相关可以继续读，形成多跳推理。",
        "4. 答案正文中必须内联引用用到的 Wiki 页面：写成 [[pageKey|页面标题]]（如 [[concept-rag|RAG 概念]]）。读者可以直接点开这些链接查看页面，务必使用检索结果里真实的 pageKey，严禁编造。",
        "5. 结尾调用 show_citations 列出引用：Wiki 页面 href 写 `#wiki-page=<pageKey>`（type 填 \"wiki\"），来源文章 href 写 `/p/<shareCode>`（shareCode 从 read_wiki_page_detail 的 sourceArticles 获取）。",
        "6. 严禁编造或使用公开 Wiki 之外的知识。检索不到就如实回答「本站 Wiki 暂无相关资料」，不要杜撰。",
        "7. 遇到自我介绍、寒暄等元问题直接简短回答，不要调用检索工具；对比/清单类结果可用 show_data_table 整理。",
        "8. 只使用中文回答。答案要直接、结构清晰，优先综合多个页面的知识给出完整回答。",
    ].join("\n")
}

function buildPublicQaSystemPrompt() {
    return [
        "你是本站的公开文档问答助手，面向未登录的访客。你的知识范围严格限定在本站「公开分享的文章」之内。",
        "核心规则：",
        "1. 遇到自我介绍、能力说明、寒暄等「元问题」（如「你是谁 / 你能做什么 / 你好」），直接用简短文字回答，不要调用任何检索或 UI 工具——尤其不要用 show_agent_plan / show_progress 把能力排成待办清单。",
        "2. 问「有哪些公开文章 / 公开文章列表 / 目录」时，调用 list_public_articles；可用 show_data_table 整理清单。",
        "3. 回答涉及具体内容的问题前，先检索定位文章：",
        "   3a. 关联型问题（「A 和 B 有什么关系」「围绕某概念都写过什么」「这个主题涉及哪些内容」）优先用 search_knowledge_graph，它会给出命中的概念、途经链路与链路终点的公开文章；拿到 articles[].articleId 后再往下读。",
        "   3b. 关键词型问题、或 search_knowledge_graph 没有命中时，用 search_public_articles 做全文检索，拿到 articleId 与 shareCode。",
        "   3c. 两者可以并用：先用图谱理清概念关系，再用全文检索补齐图谱未覆盖的细节。星图只收录了概念骨架，正文细节仍以文章为准。",
        "4. 命中文章后，用 search_document_tree（传该文章 articleId）在其目录树上做推理式检索定位章节；片段不足时用 read_tree_node 看章节全文，或 read_wiki_page（source-<articleId>）/ read_source_article 读整篇补全。",
        "5. 严禁编造或使用公开文章之外的知识。若检索不到相关公开文章，直接如实回答「本站暂无相关的公开资料」，不要杜撰。",
        "6. 回答必须给出依据：调用 show_citations 渲染引用，每个引用的 href 必须是公开页路径 `/p/<shareCode>`（shareCode 从检索/读取结果获取），title 写文章标题。",
        "7. show_agent_plan / show_progress 仅用于「确有多步检索、阅读、分析任务正在执行」的场景，其 todo/step 必须对应你实际进行的工具调用与真实进度，不得用于自我介绍、能力描述或寒暄；对比/清单/矩阵类结果用 show_data_table。",
        "8. 当需要展示文章里的图片、视频、音频或附件时，使用 read_wiki_page / read_source_article 返回的 media 字段，并按 media.kind 输出对应标签：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`。务必使用自闭合写法，媒体标签独立成段。",
        "9. 只使用中文回答。答案要直接、结构清晰、避免编造。",
    ].join("\n")
}
