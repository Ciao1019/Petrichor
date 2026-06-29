import type { NextRequest } from "next/server"
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
import { requireCurrentUser } from "@/server/auth/current-user"
import { createChatLanguageModel } from "@/server/ai/generation"
import { toErrorResponse } from "@/server/http/response"
import {
    assertKnowledgeBaseOwner,
    createAgentArtifact,
    createAgentRun,
    ensureAgentThread,
    finishAgentRun,
    idSchema,
    ingestKnowledgeBaseWiki,
    listUserKnowledgeBases,
    persistAgentMessage,
    proposeWikiPatchFromAgent,
    readSourceArticleForAgent,
    readWikiPageForAgent,
    recordAgentStep,
    runWikiLint,
    searchWikiPagesAcrossKbs,
    searchWikiPagesForAgent,
} from "@/server/kb/wiki-agent-logic"
import { readTreeNodeForAgent, retrieveTreeNodesForAgent } from "@/server/kb/wiki-tree"
import { getDb } from "@/server/db/client"

export const maxDuration = 300

const chatRequestSchema = z.object({
    knowledgeBaseId: idSchema.optional().nullable(),
    threadId: idSchema.optional().nullable(),
    messages: z.array(z.unknown()).min(1),
    configId: idSchema.optional().nullable(),
})

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

const citationToolSchema = z.object({
    citations: z.array(z.object({
        id: z.string().min(1),
        // 允许相对路径 (例如 /dashboard/knowledge/1/articles/5) 以便客户端 react-router 内部跳转
        href: z.string().min(1),
        title: z.string(),
        snippet: z.string().optional(),
        domain: z.string().optional(),
        type: z.enum(["webpage", "document", "article", "api", "code", "other"]).optional(),
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

const patchToolSchema = z.object({
    pageKey: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    proposedContentMd: z.string().min(1),
    reason: z.string().optional(),
})

const artifactToolSchema = z.object({
    artifactType: z.enum(["answer", "table", "timeline", "report", "notes"]).default("answer"),
    title: z.string().min(1).max(200),
    contentMd: z.string().optional(),
    payload: z.unknown().optional(),
})

export async function POST(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = chatRequestSchema.parse(await request.json())
        const db = getDb()
        const knowledgeBaseId = input.knowledgeBaseId ?? null
        if (knowledgeBaseId != null) {
            await assertKnowledgeBaseOwner(db, user.id, knowledgeBaseId)
        }

        const thread = await ensureAgentThread({
            userId: user.id,
            knowledgeBaseId,
            threadId: input.threadId ?? null,
            title: extractLastUserText(input.messages) || "文档问答",
        })

        const lastUserText = extractLastUserText(input.messages)
        if (lastUserText) {
            await persistAgentMessage({
                userId: user.id,
                knowledgeBaseId,
                threadId: thread.id,
                role: "user",
                contentText: lastUserText,
                content: input.messages.at(-1),
            })
        }

        const { model, config } = await createChatLanguageModel({
            userId: user.id,
            configId: input.configId ?? null,
        })
        const run = await createAgentRun({
            userId: user.id,
            knowledgeBaseId,
            threadId: thread.id,
            modelName: config.model,
        })

        const tools = knowledgeBaseId == null
            ? buildGlobalAgentTools({
                userId: user.id,
                threadId: thread.id,
                runId: run.id,
            })
            : buildKnowledgeAgentTools({
                userId: user.id,
                knowledgeBaseId,
                threadId: thread.id,
                runId: run.id,
            })

        const inputTokenEstimate = estimateConversationInputTokens(input.messages)
        let assistantTextAccumulator = ""
        const streamStartedAt = Date.now()
        let firstTokenAtMs: number | null = null
        let chunkCount = 0
        let finalUsageMetadata: AssistantUsageMetadata | null = null
        let finalModelId: string | null = null

        const result = streamText({
            model,
            instructions: knowledgeBaseId == null ? buildGlobalAgentSystemPrompt() : buildAgentSystemPrompt(),
            messages: await convertToModelMessages(input.messages as UIMessage[]),
            tools,
            stopWhen: isStepCount(8),
            temperature: 0.2,
            onToolExecutionEnd: async (event) => {
                const isSuccess = event.toolOutput.type === "tool-result"
                await recordAgentStep({
                    runId: run.id,
                    userId: user.id,
                    knowledgeBaseId,
                    stepType: event.toolCall.toolName,
                    title: isSuccess ? `完成工具：${event.toolCall.toolName}` : `工具失败：${event.toolCall.toolName}`,
                    status: isSuccess ? "COMPLETED" : "FAILED",
                    payload: isSuccess ? event.toolOutput.output : { error: String(event.toolOutput.error) },
                })
            },
            onEnd: async () => {
                if (!finalUsageMetadata) {
                    // Fallback if messageMetadata callback didn't compute usage (e.g. stream aborted)
                    finalUsageMetadata = normalizeOrEstimateUsage({
                        usage: undefined,
                        inputTokenEstimate,
                        assistantText: assistantTextAccumulator,
                    })
                }
                await finishAgentRun({
                    runId: run.id,
                    userId: user.id,
                    status: "COMPLETED",
                })
            },
            onError: async (error) => {
                await finishAgentRun({
                    runId: run.id,
                    userId: user.id,
                    status: "FAILED",
                    errorMessage: error instanceof Error ? error.message : String(error),
                })
            },
        })

        return createUIMessageStreamResponse({
            stream: toUIMessageStream({
                stream: result.stream,
                tools,
                onEnd: async ({ responseMessage }) => {
                    // 此回调拿到的 responseMessage 是完整的 UIMessage，包含 text + tool-call + reasoning 所有 part，
                    // 用它持久化才能让历史对话刷新后保留工具卡片渲染。
                    const finishedAt = Date.now()
                    const totalStreamTime = finishedAt - streamStartedAt
                    const firstTokenTime = firstTokenAtMs != null ? firstTokenAtMs - streamStartedAt : null
                    const usage = finalUsageMetadata ?? normalizeOrEstimateUsage({
                        usage: undefined,
                        inputTokenEstimate,
                        assistantText: assistantTextAccumulator,
                    })
                    const outputTokens = usage.outputTokens ?? 0
                    const tokensPerSecond = totalStreamTime > 0 && outputTokens > 0
                        ? Number((outputTokens / (totalStreamTime / 1000)).toFixed(2))
                        : null
                    const textContent = extractTextFromUIMessage(responseMessage)
                    await persistAgentMessage({
                        userId: user.id,
                        knowledgeBaseId,
                        threadId: thread.id,
                        role: "assistant",
                        contentText: textContent,
                        content: {
                            parts: responseMessage.parts,
                            text: textContent,
                            usage,
                            modelId: finalModelId ?? config.model,
                            modelName: config.name,
                            firstTokenTime,
                            totalStreamTime,
                            totalChunks: chunkCount,
                            tokensPerSecond,
                            startedAt: streamStartedAt,
                            finishedAt,
                        },
                    })
                },
                messageMetadata: ({ part }) => {
                    if (part.type === "text-delta") {
                        if (firstTokenAtMs == null) firstTokenAtMs = Date.now()
                        assistantTextAccumulator += part.text
                        chunkCount += 1
                        return undefined
                    }
                    if (part.type === "finish-step") {
                        finalModelId = part.response.modelId ?? finalModelId
                        return { custom: { modelId: part.response.modelId } }
                    }
                    if (part.type === "finish") {
                        const usage = normalizeOrEstimateUsage({
                            usage: part.totalUsage,
                            inputTokenEstimate,
                            assistantText: assistantTextAccumulator,
                        })
                        finalUsageMetadata = usage
                        const finishedAt = Date.now()
                        const totalStreamTime = finishedAt - streamStartedAt
                        const firstTokenTime = firstTokenAtMs != null ? firstTokenAtMs - streamStartedAt : undefined
                        const outputTokens = usage.outputTokens ?? 0
                        const tokensPerSecond = totalStreamTime > 0 && outputTokens > 0
                            ? Number((outputTokens / (totalStreamTime / 1000)).toFixed(2))
                            : undefined
                        // assistant-ui 的 message converter 只保留 metadata.custom / steps / timing 等已知字段，
                        // 顶层未知键会被丢弃，所以 usage / 计时数据必须放进 custom 才能落到 thread.messages 上。
                        return {
                            custom: {
                                usage,
                                firstTokenTime,
                                totalStreamTime,
                                totalChunks: chunkCount,
                                ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
                                ...(finalModelId ? { modelId: finalModelId } : {}),
                            },
                        }
                    }
                    return undefined
                },
            }),
            headers: {
                "X-Petrichor-Agent-Thread-Id": String(thread.id),
                "X-Petrichor-Agent-Run-Id": String(run.id),
            },
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

function buildKnowledgeAgentTools(context: {
    userId: number
    knowledgeBaseId: number
    threadId: number
    runId: number
}) {
    return {
        show_agent_plan: tool({
            description: "当用户问题需要多步阅读、分析或更新 Wiki 时，先展示清晰执行计划。",
            inputSchema: planToolSchema,
            execute: async (input) => ({
                id: `plan-${Date.now()}`,
                title: input.title,
                description: input.description,
                todos: input.todos,
            }),
        }),
        show_progress: tool({
            description: "展示当前阅读、分析、校验或写入 Wiki 的执行进度。",
            inputSchema: progressToolSchema,
            execute: async (input) => ({
                id: `progress-${Date.now()}`,
                title: input.title,
                description: input.description,
                steps: input.steps,
            }),
        }),
        compile_wiki: tool({
            description: "当 Wiki 尚未建立或明显过期时，编译当前知识库文章为 Wiki 中间层。",
            inputSchema: z.object({
                forceRebuild: z.boolean().optional().default(false),
            }),
            execute: async ({ forceRebuild }) => await ingestKnowledgeBaseWiki({
                userId: context.userId,
                knowledgeBaseId: context.knowledgeBaseId,
                forceRebuild,
            }),
        }),
        read_wiki_index: tool({
            description: "读取 Wiki 索引，作为回答文档问题的第一步。",
            inputSchema: z.object({}),
            execute: async () => await readWikiPageForAgent(context.userId, context.knowledgeBaseId, "index")
                .catch(async () => {
                    await ingestKnowledgeBaseWiki({
                        userId: context.userId,
                        knowledgeBaseId: context.knowledgeBaseId,
                    })
                    return await readWikiPageForAgent(context.userId, context.knowledgeBaseId, "index")
                }),
        }),
        search_document_tree: tool({
            description: "推理式检索：在文档目录树（PageIndex 式层级结构）上按问题推理导航，返回最相关的章节节点（含面包屑路径、摘要、原文片段、所属 articleId 与 nodeKey）。回答细节性问题时优先用它，比关键词搜索更精准。",
            inputSchema: z.object({
                query: z.string().min(1),
                limit: z.number().int().min(1).max(12).optional(),
                articleId: idSchema.optional(),
            }),
            execute: async ({ query, limit, articleId }) => await retrieveTreeNodesForAgent({
                userId: context.userId,
                knowledgeBaseId: context.knowledgeBaseId,
                query,
                limit,
                articleId: articleId ?? undefined,
            }),
        }),
        read_tree_node: tool({
            description: "读取目录树中某个章节节点的完整内容（含面包屑路径、子节点与媒体引用）。当 search_document_tree 返回的片段被截断、需要看全文时使用，传 nodeKey。",
            inputSchema: z.object({
                nodeKey: z.string().min(1),
            }),
            execute: async ({ nodeKey }) => {
                const node = await readTreeNodeForAgent(context.userId, context.knowledgeBaseId, nodeKey)
                return node ?? { error: "目录节点不存在", nodeKey }
            },
        }),
        search_wiki_pages: tool({
            description: "按关键词搜索 Wiki 页面（整篇粒度的兜底检索）。需要章节级精准定位时优先用 search_document_tree。",
            inputSchema: z.object({
                query: z.string().min(1),
                limit: z.number().int().min(1).max(12).optional(),
            }),
            execute: async ({ query, limit }) => await searchWikiPagesForAgent({
                userId: context.userId,
                knowledgeBaseId: context.knowledgeBaseId,
                query,
                limit,
            }),
        }),
        read_wiki_page: tool({
            description: "读取一个具体 Wiki 页面。用于获得可引用、可回答的中间知识；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                pageKey: z.string().min(1),
            }),
            execute: async ({ pageKey }) => await readWikiPageForAgent(context.userId, context.knowledgeBaseId, pageKey),
        }),
        read_source_article: tool({
            description: "当 Wiki 页面不足以回答、需要核验原文或查看图片时读取源文档；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                articleId: idSchema,
            }),
            execute: async ({ articleId }) => await readSourceArticleForAgent(context.userId, context.knowledgeBaseId, articleId),
        }),
        show_citations: tool({
            description: "把最终答案使用的 Wiki 页面或源文档引用渲染为引用卡片。",
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
        propose_wiki_patch: tool({
            description: "当回答中产生了值得长期沉淀的新结论时，提出 Wiki 补丁等待用户审批，不要直接写入。",
            inputSchema: patchToolSchema,
            execute: async (input) => await proposeWikiPatchFromAgent({
                userId: context.userId,
                knowledgeBaseId: context.knowledgeBaseId,
                threadId: context.threadId,
                runId: context.runId,
                pageKey: input.pageKey,
                title: input.title,
                proposedContentMd: input.proposedContentMd,
                reason: input.reason,
            }),
        }),
        save_answer_artifact: tool({
            description: "保存本轮回答的结构化产物，便于右侧 Artifact 面板复看。",
            inputSchema: artifactToolSchema,
            execute: async (input) => await createAgentArtifact({
                userId: context.userId,
                knowledgeBaseId: context.knowledgeBaseId,
                threadId: context.threadId,
                runId: context.runId,
                artifactType: input.artifactType,
                title: input.title,
                contentMd: input.contentMd,
                payload: input.payload,
            }),
        }),
        run_wiki_lint: tool({
            description: "检查 Wiki 是否存在缺失引用、断链、孤立页面等维护问题。",
            inputSchema: z.object({}),
            execute: async () => await runWikiLint(context.userId, context.knowledgeBaseId),
        }),
    }
}

function buildAgentSystemPrompt() {
    return [
        "你是 Petrichor 的文档问答 Agent，负责基于 Wiki 编译层与文档目录树回答用户问题。",
        "核心规则：",
        "1. 回答关于文档内容的问题时，第一步先调用 search_document_tree 在章节目录树上做推理式检索，定位最相关的章节（这是默认首选的检索方式）。",
        "1.1 树检索与 Wiki/源文档是互补关系，应按需配合：当命中片段不足、需要更完整的上下文，或要展示图片/视频/附件等媒体时，再结合 read_tree_node 读该章节全文、或 read_wiki_page / read_source_article 读整篇来补全，不要只停在树检索片段上。read_wiki_index 用于需要纵览「这个知识库里有哪些文档」时；search_wiki_pages 作为树检索不到结果时的整篇粒度兜底。",
        "2. 只有目录树与 Wiki 都不足、需要核验或引用原文时，才调用 read_source_article。",
        "3. 回答必须给出依据；适合时调用 show_citations 渲染引用。引用 href 必须用文章详情页路径，格式为 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>`，title 写「页面标题」，domain 写「知识库名」。articleId 从 search/read 工具返回的 articleId 字段获取，或从 pageKey `source-<id>` 解析。",
        "4. 涉及多步分析时先调用 show_agent_plan，执行中可调用 show_progress。",
        "5. 每次回答后都要主动评估「这次内容是否值得回写 Wiki」，满足任一条件就调用 propose_wiki_patch 提交待审批补丁：(a) Wiki 缺少该主题对应的页面；(b) 现有页面信息过时、不完整、或与源文档有出入；(c) 你综合多处来源 / 基于源文档整理出了现有 Wiki 页面尚未记录的结论。调用时必须给出：pageKey（更新填现有页面的 pageKey，新建用语义化的英文短横线 key 如 `topic-mole-cli`）、title、完整的 proposedContentMd（Markdown 正文）、reason（一句话说明为什么值得沉淀）。只提交补丁等用户审批，绝不声称已写入 Wiki。仅当内容与现有 Wiki 已基本一致、没有实质增量时才跳过，避免噪音补丁。",
        "6. 对比、矩阵、清单类结果优先调用 show_data_table。",
        "7. 可复用的最终答案调用 save_answer_artifact 保存为产物。",
        "8. 当用户需要查看或下载文档里的图片、架构图、截图、图表、视频、音频或附件时，必须查看 read_wiki_page / read_source_article 返回的 media 字段，并按每项的 media.kind 在最终答案中直接输出对应标签（src 一律使用 media.src 原值，不要只给对象路径或只让用户点击引用卡片）：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`（name 用 media.filename）。务必使用自闭合写法，不要输出 `</video>`、`</audio>`、`</file>` 等闭合标签；这些媒体标签要独立成段，不要放进表格单元格里。",
        "9. 只使用中文回答。答案要直接、结构清晰、避免编造。",
    ].join("\n")
}

function buildGlobalAgentSystemPrompt() {
    return [
        "你是 Petrichor 的跨知识库文档问答 Agent。本次对话覆盖用户的所有知识库。",
        "核心规则：",
        "1. 当用户提问时，先调用 list_knowledge_bases 了解用户有哪些知识库（如有需要）。",
        "2. 使用 search_across_kbs 在所有知识库的 Wiki 页面中检索关键词，找到最可能命中的知识库与页面。",
        "3. 命中后调用 read_wiki_page 读取详细内容；如果 Wiki 不足以回答，可用 read_source_article 核验原文。",
        "4. 回答必须给出依据，调用 show_citations 渲染引用。每个引用的 href 必须填可跳转的文章详情页路径：`/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>`。articleId 从工具返回值的 articleId 字段获取；如果只有 pageKey 形如 `source-<id>`，可以解析出 articleId。title 写「页面标题」，domain 写「知识库名」。",
        "5. 涉及多步分析时调用 show_agent_plan / show_progress。结构化结果调用 show_data_table。",
        "6. 不要直接修改 Wiki；如果需要沉淀结论，请提示用户去具体知识库内提交补丁。",
        "7. 当用户需要查看或下载文档里的图片、架构图、截图、图表、视频、音频或附件时，必须查看 read_wiki_page / read_source_article 返回的 media 字段，并按每项的 media.kind 在最终答案中直接输出对应标签（src 一律使用 media.src 原值，不要只给对象路径或只让用户点击引用卡片）：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`（name 用 media.filename）。务必使用自闭合写法，不要输出 `</video>`、`</audio>`、`</file>` 等闭合标签；这些媒体标签要独立成段，不要放进表格单元格里。",
        "8. 只使用中文回答。答案要直接、结构清晰、避免编造；明确告诉用户答案来自哪个知识库。",
    ].join("\n")
}

function buildGlobalAgentTools(context: {
    userId: number
    threadId: number
    runId: number
}) {
    return {
        show_agent_plan: tool({
            description: "当用户问题需要多步阅读、分析时，先展示清晰执行计划。",
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
        list_knowledge_bases: tool({
            description: "列出当前用户的所有知识库，用于跨库检索前的概览。",
            inputSchema: z.object({}),
            execute: async () => await listUserKnowledgeBases(context.userId),
        }),
        search_across_kbs: tool({
            description: "在用户所有知识库的 Wiki 页面里检索关键词，返回排序后的命中页面（含所属知识库）。",
            inputSchema: z.object({
                query: z.string().min(1),
                limit: z.number().int().min(1).max(20).optional(),
            }),
            execute: async ({ query, limit }) => await searchWikiPagesAcrossKbs({
                userId: context.userId,
                query,
                limit,
            }),
        }),
        read_wiki_page: tool({
            description: "读取指定知识库内的具体 Wiki 页面。需要传 knowledgeBaseId（数字字符串）和 pageKey；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                knowledgeBaseId: idSchema,
                pageKey: z.string().min(1),
            }),
            execute: async ({ knowledgeBaseId, pageKey }) => await readWikiPageForAgent(context.userId, knowledgeBaseId, pageKey),
        }),
        read_source_article: tool({
            description: "读取指定知识库内的源文档。仅在 Wiki 信息不足或需要查看图片时使用；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                knowledgeBaseId: idSchema,
                articleId: idSchema,
            }),
            execute: async ({ knowledgeBaseId, articleId }) => await readSourceArticleForAgent(context.userId, knowledgeBaseId, articleId),
        }),
        show_citations: tool({
            description: "把最终答案使用的 Wiki 页面或源文档引用渲染为引用卡片。",
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
        save_answer_artifact: tool({
            description: "保存本轮回答的结构化产物。",
            inputSchema: artifactToolSchema,
            execute: async (input) => await createAgentArtifact({
                userId: context.userId,
                knowledgeBaseId: null,
                threadId: context.threadId,
                runId: context.runId,
                artifactType: input.artifactType,
                title: input.title,
                contentMd: input.contentMd,
                payload: input.payload,
            }),
        }),
    }
}

function extractLastUserText(messages: unknown[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: unknown; content?: unknown; parts?: unknown }
        if (message?.role !== "user") continue
        const text = extractTextFromMessage(message)
        if (text.trim()) return text.trim()
    }
    return ""
}

function extractTextFromMessage(message: { content?: unknown; parts?: unknown }) {
    if (typeof message.content === "string") return message.content
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : []
    return parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { text?: unknown; type?: unknown }
            return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
        })
        .filter(Boolean)
        .join("\n")
}

type AssistantUsageMetadata = {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    estimated?: boolean
}

type AssistantUsageSource = {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: {
        cacheReadTokens?: number
    }
    outputTokenDetails?: {
        reasoningTokens?: number
    }
}

function normalizeOrEstimateUsage(input: {
    usage: AssistantUsageSource | undefined
    inputTokenEstimate: number
    assistantText: string
}): AssistantUsageMetadata {
    const usage = input.usage
    const result: AssistantUsageMetadata = {}
    if (typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0) {
        result.inputTokens = usage.inputTokens
    }
    if (typeof usage?.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
        result.outputTokens = usage.outputTokens
    }
    if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
        result.totalTokens = usage.totalTokens
    }
    const reasoningTokens = usage?.reasoningTokens ?? usage?.outputTokenDetails?.reasoningTokens
    if (typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens >= 0) {
        result.reasoningTokens = reasoningTokens
    }
    const cachedInputTokens = usage?.cachedInputTokens ?? usage?.inputTokenDetails?.cacheReadTokens
    if (typeof cachedInputTokens === "number" && Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0) {
        result.cachedInputTokens = cachedInputTokens
    }
    const hasReal = (result.totalTokens ?? 0) > 0 || (result.inputTokens ?? 0) > 0 || (result.outputTokens ?? 0) > 0
    if (hasReal) {
        if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
            result.totalTokens = result.inputTokens + result.outputTokens
        }
        return result
    }
    const inputTokens = input.inputTokenEstimate
    const outputTokens = estimateTokensFromText(input.assistantText)
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: true,
    }
}

function estimateConversationInputTokens(messages: unknown[]) {
    let total = 0
    for (const message of messages) {
        const text = extractTextFromMessage(message as { content?: unknown; parts?: unknown })
        total += estimateTokensFromText(text)
    }
    return total
}

function extractTextFromUIMessage(message: { parts?: unknown }) {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts
        .map((part) => {
            if (!part || typeof part !== "object") return ""
            const candidate = part as { type?: unknown; text?: unknown }
            return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
        })
        .filter(Boolean)
        .join("\n")
}

function estimateTokensFromText(text: string) {
    if (!text) return 0
    let tokens = 0
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        if (
            (code >= 0x4e00 && code <= 0x9fff)
            || (code >= 0x3040 && code <= 0x30ff)
            || (code >= 0xac00 && code <= 0xd7af)
        ) {
            tokens += 1
        } else {
            tokens += 0.25
        }
    }
    return Math.max(1, Math.ceil(tokens))
}
