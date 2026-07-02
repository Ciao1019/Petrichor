import { after, type NextRequest } from "next/server"
import {
    convertToModelMessages,
    createUIMessageStreamResponse,
    isStepCount,
    streamText,
    toUIMessageStream,
    tool,
    type LanguageModel,
    type UIMessage,
} from "ai"
import { z } from "zod"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
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
import { loadAgentMemoryPromptSection, maybeDistillAgentMemory } from "@/server/kb/agent-memory"
import { readTreeNodeForAgent, retrieveTreeNodesForAgent, semanticSearchTreeNodes } from "@/server/kb/wiki-tree"
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

        const subAgentUsageAcc = createSubAgentUsageAccumulator()
        const tools = knowledgeBaseId == null
            ? buildGlobalAgentTools({
                userId: user.id,
                threadId: thread.id,
                runId: run.id,
                model,
                onSubagentUsage: (usage) => addSubAgentUsage(subAgentUsageAcc, usage),
            })
            : buildKnowledgeAgentTools({
                userId: user.id,
                knowledgeBaseId,
                threadId: thread.id,
                runId: run.id,
            })

        // 跨 thread 长期记忆：注入历史蒸馏出的用户偏好/常关注主题（无记忆时为 null）
        const memorySection = await loadAgentMemoryPromptSection(user.id)

        const inputTokenEstimate = estimateConversationInputTokens(input.messages)
        let assistantTextAccumulator = ""
        const streamStartedAt = Date.now()
        let firstTokenAtMs: number | null = null
        let chunkCount = 0
        let finalUsageMetadata: AssistantUsageMetadata | null = null
        let finalModelId: string | null = null

        const result = streamText({
            model,
            instructions: knowledgeBaseId == null
                ? buildGlobalAgentSystemPrompt(memorySection)
                : buildAgentSystemPrompt(memorySection),
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

        // 响应结束后异步蒸馏长期记忆；内部限频（≥12 小时且 ≥5 条新提问），绝大多数请求直接短路
        scheduleAgentMemoryDistillation(user.id)

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
                    const subAgentUsage = summarizeSubAgentUsage(subAgentUsageAcc)
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
                            ...(subAgentUsage ? { subAgentUsage } : {}),
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
                        const subAgentUsage = summarizeSubAgentUsage(subAgentUsageAcc)
                        return {
                            custom: {
                                usage,
                                firstTokenTime,
                                totalStreamTime,
                                totalChunks: chunkCount,
                                ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
                                ...(finalModelId ? { modelId: finalModelId } : {}),
                                ...(subAgentUsage ? { subAgentUsage } : {}),
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
        ...buildKbRetrievalTools({ userId: context.userId, knowledgeBaseId: context.knowledgeBaseId }),
        show_citations: tool({
            description: "把最终答案使用的 Wiki 页面或源文档引用渲染为引用卡片。href 必须优先使用检索/读取工具返回的 href，或按 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>` 生成，禁止使用 `/document/<id>`。",
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

function scheduleAgentMemoryDistillation(userId: number) {
    try {
        after(() => maybeDistillAgentMemory(userId))
    } catch {
        setTimeout(() => {
            void maybeDistillAgentMemory(userId)
        }, 0)
    }
}

function buildAgentSystemPrompt(memorySection?: string | null) {
    return [
        "你是 Petrichor 的文档问答 Agent，负责基于 Wiki 编译层与文档目录树回答用户问题。",
        "核心规则：",
        "1. 回答关于文档内容的问题时，第一步先调用 search_document_tree 在章节目录树上做推理式检索，定位最相关的章节（这是默认首选的检索方式）。",
        "1.1 树检索与 Wiki/源文档是互补关系，应按需配合：当命中片段不足、需要更完整的上下文，或要展示图片/视频/附件等媒体时，再结合 read_tree_node 读该章节全文、或 read_wiki_page / read_source_article 读整篇来补全，不要只停在树检索片段上。read_wiki_index 用于需要纵览「这个知识库里有哪些文档」时；search_wiki_pages 作为树检索不到结果时的整篇粒度兜底。",
        "1.2 当用户用近义/概念性表述提问，或 search_document_tree 推理导航召回不佳时，改用或补充 semantic_search_tree 做向量语义检索（返回结构与 search_document_tree 一致）。",
        "2. 只有目录树与 Wiki 都不足、需要核验或引用原文时，才调用 read_source_article。",
        "3. 回答必须给出依据；适合时调用 show_citations 渲染引用。引用 href 必须优先使用 search/read 工具返回的 href，或用文章详情页路径 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>`；禁止使用 `/document/<id>`。title 写「页面标题」，domain 写「知识库名」。articleId 从 search/read 工具返回的 articleId 字段获取，或从 pageKey `source-<id>` 解析。",
        "4. 涉及多步分析时先调用 show_agent_plan，执行中可调用 show_progress。",
        "5. 每次回答后都要主动评估「这次内容是否值得回写 Wiki」，满足任一条件就调用 propose_wiki_patch 提交待审批补丁：(a) Wiki 缺少该主题对应的页面；(b) 现有页面信息过时、不完整、或与源文档有出入；(c) 你综合多处来源 / 基于源文档整理出了现有 Wiki 页面尚未记录的结论。调用时必须给出：pageKey（更新填现有页面的 pageKey，新建用语义化的英文短横线 key 如 `topic-mole-cli`）、title、完整的 proposedContentMd（Markdown 正文）、reason（一句话说明为什么值得沉淀）。只提交补丁等用户审批，绝不声称已写入 Wiki。仅当内容与现有 Wiki 已基本一致、没有实质增量时才跳过，避免噪音补丁。",
        "6. 对比、矩阵、清单类结果优先调用 show_data_table。",
        "7. 可复用的最终答案调用 save_answer_artifact 保存为产物。",
        "8. 当用户需要查看或下载文档里的图片、架构图、截图、图表、视频、音频或附件时，必须查看 read_wiki_page / read_source_article 返回的 media 字段，并按每项的 media.kind 在最终答案中直接输出对应标签（src 一律使用 media.src 原值，不要只给对象路径或只让用户点击引用卡片）：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`（name 用 media.filename）。务必使用自闭合写法，不要输出 `</video>`、`</audio>`、`</file>` 等闭合标签；这些媒体标签要独立成段，不要放进表格单元格里。",
        "9. 只使用中文回答。答案要直接、结构清晰、避免编造。",
        ...(memorySection ? ["", memorySection] : []),
    ].join("\n")
}

function buildGlobalAgentSystemPrompt(memorySection?: string | null) {
    return [
        "你是 Petrichor 的跨知识库文档问答 Agent。本次对话覆盖用户的所有知识库。",
        "核心规则：",
        "1. 对于需要综合知识库内容的实质性问题，**优先调用 deep_research_kbs**（自动并行检索多个相关知识库，每个库派一个检索子 Agent）。它返回 kbs[]（每个库的 findings 结论）与 citations（可引用来源）。默认不传 knowledgeBaseIds 让它自动挑库；只有当用户明确点名某几个库时才传。",
        "2. 拿到 deep_research_kbs 结果后，你负责**综合各库 findings 写出统一答案**，逐条结论要明确标注来自哪个知识库；忽略 findings 为「本知识库无相关内容」的库。随后调用 show_citations 渲染引用，**直接使用返回的 citations**（其 href/title/domain 已就绪）。",
        "3. 仅当用户只是想「我有哪些知识库/做个概览」这类轻量问题时，才用 list_knowledge_bases；需要一次性关键词粗扫时可用 search_across_kbs。需要对单个库补充核验时可用 read_wiki_page / read_source_article。",
        "4. 引用 href 必须优先使用工具返回的 href；没有 href 时才按可跳转的文章详情页路径 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>` 生成；禁止使用 `/document/<id>`。title 写「页面标题」，domain 写「知识库名」。",
        "5. 涉及多步分析时调用 show_agent_plan / show_progress。结构化对比结果调用 show_data_table。",
        "6. 不要直接修改 Wiki；如果需要沉淀结论，请提示用户去具体知识库内提交补丁。",
        "7. 当用户需要查看或下载文档里的图片、架构图、截图、图表、视频、音频或附件时，必须查看 read_wiki_page / read_source_article 返回的 media 字段，并按每项的 media.kind 在最终答案中直接输出对应标签（src 一律使用 media.src 原值，不要只给对象路径或只让用户点击引用卡片）：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`（name 用 media.filename）。务必使用自闭合写法，不要输出 `</video>`、`</audio>`、`</file>` 等闭合标签；这些媒体标签要独立成段，不要放进表格单元格里。",
        "8. 只使用中文回答。答案要直接、结构清晰、避免编造；明确告诉用户答案来自哪个知识库。",
        ...(memorySection ? ["", memorySection] : []),
    ].join("\n")
}

function buildGlobalAgentTools(context: {
    userId: number
    threadId: number
    runId: number
    model: LanguageModel
    onSubagentUsage?: (usage: AssistantUsageSource | undefined) => void
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
        deep_research_kbs: tool({
            description: "跨知识库并行深度检索：自动（或按 knowledgeBaseIds 指定）挑选最相关的若干知识库，为每个库派一个流式检索子 Agent 并行深挖，返回每个库的结论（findings）与可引用来源（citations）。回答需要综合多个知识库内容的实质性问题时优先使用它，而不是自己逐库 read_wiki_page。",
            inputSchema: z.object({
                query: z.string().min(1).describe("要在各知识库中研究的问题（可在用户原问题基础上提炼得更聚焦）"),
                knowledgeBaseIds: z.array(idSchema).min(1).max(MAX_PARALLEL_KBS).optional()
                    .describe("可选：显式指定要并行检索的知识库 id；不传则根据 query 自动挑选候选库"),
            }),
            execute: async function* ({ query, knowledgeBaseIds }, { abortSignal }) {
                return yield* runDeepResearchAcrossKbs({
                    userId: context.userId,
                    model: context.model,
                    query,
                    knowledgeBaseIds: knowledgeBaseIds ?? null,
                    abortSignal,
                    onSubagentUsage: context.onSubagentUsage,
                })
            },
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
            description: "把最终答案使用的 Wiki 页面或源文档引用渲染为引用卡片。href 必须优先使用检索/读取工具返回的 href，或按 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>` 生成，禁止使用 `/document/<id>`。",
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

// 单库检索工具子集：单库问答 Agent 与跨库并行子 Agent 共用，保证检索行为一致。
function buildKbRetrievalTools(context: {
    userId: number
    knowledgeBaseId: number
}) {
    return {
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
        semantic_search_tree: tool({
            description: "向量语义检索：对目录树章节节点做向量相似度召回。当用户用近义/概念性表述、或 search_document_tree 推理导航召回不佳时使用；返回结构与 search_document_tree 一致（含面包屑路径、摘要、原文片段、articleId 与 nodeKey）。可传 articleId 限定单篇。",
            inputSchema: z.object({
                query: z.string().min(1),
                limit: z.number().int().min(1).max(12).optional(),
                articleId: idSchema.optional(),
            }),
            execute: async ({ query, limit, articleId }) => {
                try {
                    return await semanticSearchTreeNodes({
                        userId: context.userId,
                        knowledgeBaseId: context.knowledgeBaseId,
                        query,
                        limit,
                        articleId: articleId ?? undefined,
                    })
                } catch {
                    return { hits: [], note: "语义检索当前不可用（未配置向量模型、Wiki 尚未编译或数据库不支持），请改用 search_document_tree。" }
                }
            },
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
    }
}

// ===== 跨库并行深度检索（Orchestrator + 每库一个流式检索子 Agent） =====

const MAX_PARALLEL_KBS = 3
const SUBAGENT_MAX_STEPS = 5

type DeepResearchCitation = {
    id: string
    href: string
    title: string
    snippet?: string
    domain?: string
    type: "article"
}

type KbResearchProgress = {
    knowledgeBaseId: string
    knowledgeBaseName: string
    status: "pending" | "researching" | "completed" | "failed"
    steps: Array<{ tool: string; detail: string }>
    findings: string
    citations: DeepResearchCitation[]
}

type DeepResearchResult = {
    query: string
    kbs: KbResearchProgress[]
    citations: DeepResearchCitation[]
    note?: string
}

/**
 * 跨库并行深度检索。作为生成器逐 tick yield 合并进度（供 UI 实时渲染），
 * 结束时 return 聚合结果（各库 findings + 去重后的 citations）供编排器合成最终答案。
 */
async function* runDeepResearchAcrossKbs(input: {
    userId: number
    model: LanguageModel
    query: string
    knowledgeBaseIds: number[] | null
    abortSignal?: AbortSignal
    onSubagentUsage?: (usage: AssistantUsageSource | undefined) => void
}): AsyncGenerator<DeepResearchResult, DeepResearchResult> {
    const candidates = await selectCandidateKbs(input)
    if (candidates.length === 0) {
        const empty: DeepResearchResult = { query: input.query, kbs: [], citations: [], note: "未找到与该问题相关的知识库。" }
        yield empty
        return empty
    }

    const progress: KbResearchProgress[] = candidates.map((kb) => ({
        knowledgeBaseId: String(kb.id),
        knowledgeBaseName: kb.name,
        status: "pending",
        steps: [],
        findings: "",
        citations: [],
    }))

    // 事件驱动的进度合流：任一子 Agent 有进展就置 pending，生成器循环消费。
    let pending = true
    let resolveTick: (() => void) | null = null
    const tick = () => {
        pending = true
        const resolve = resolveTick
        resolveTick = null
        resolve?.()
    }
    const waitTick = () => (pending ? Promise.resolve() : new Promise<void>((resolve) => { resolveTick = resolve }))
    let finished = 0

    const tasks = candidates.map((kb, index) => (async () => {
        const entry = progress[index]
        entry.status = "researching"
        tick()
        let usageReported = false
        try {
            const sub = streamText({
                model: input.model,
                system: buildSubagentSystemPrompt(kb.name),
                prompt: input.query,
                tools: buildKbRetrievalTools({ userId: input.userId, knowledgeBaseId: kb.id }),
                stopWhen: isStepCount(SUBAGENT_MAX_STEPS),
                temperature: 0.2,
                abortSignal: input.abortSignal,
            })
            // 手动消费子 Agent 的 fullStream，把工具调用/结果 part 转发成本库的进度与引用。
            for await (const part of sub.fullStream) {
                if (part.type === "tool-call") {
                    entry.steps.push({ tool: part.toolName, detail: describeToolInput(part.toolName, part.input) })
                    if (entry.steps.length > 12) entry.steps.shift()
                    tick()
                } else if (part.type === "tool-result") {
                    collectCitationsFromToolOutput(entry, kb, part.output)
                    tick()
                }
            }
            entry.findings = (await sub.text).trim()
            entry.status = "completed"
            // totalUsage 汇总本子 Agent 全部步骤的 token，回传给编排器层单独累加。
            input.onSubagentUsage?.(await sub.totalUsage)
            usageReported = true
        } catch (error) {
            entry.status = "failed"
            entry.findings = entry.findings || `本库检索失败：${error instanceof Error ? error.message : String(error)}`
        } finally {
            if (!usageReported) input.onSubagentUsage?.(undefined)
            finished += 1
            tick()
        }
    })())

    const settled = Promise.allSettled(tasks)
    while (finished < candidates.length) {
        pending = false
        yield snapshotDeepResearch(input.query, progress)
        if (finished >= candidates.length) break
        await waitTick()
    }
    await settled
    // AI SDK 对 generator 工具用 for-await 消费，只取最后一次 yield 作为最终结果、
    // 丢弃 return 值，所以终态快照必须 yield 出去，否则 UI 停留在最后一个中间态。
    const finalSnapshot = snapshotDeepResearch(input.query, progress)
    yield finalSnapshot
    return finalSnapshot
}

async function selectCandidateKbs(input: {
    userId: number
    query: string
    knowledgeBaseIds: number[] | null
}): Promise<Array<{ id: number; name: string }>> {
    const owned = await listUserKnowledgeBases(input.userId)
    const nameById = new Map(owned.map((kb) => [Number(kb.id), kb.name]))

    // 显式指定：只保留用户拥有的库。
    if (input.knowledgeBaseIds && input.knowledgeBaseIds.length > 0) {
        const picked: Array<{ id: number; name: string }> = []
        const seen = new Set<number>()
        for (const rawId of input.knowledgeBaseIds) {
            const id = Number(rawId)
            const name = nameById.get(id)
            if (name != null && !seen.has(id)) {
                seen.add(id)
                picked.push({ id, name })
            }
        }
        return picked.slice(0, MAX_PARALLEL_KBS)
    }

    // 自动挑选：按 Wiki 关键词命中在各库的排名加权打分，取 top-K。
    const hits = await searchWikiPagesAcrossKbs({ userId: input.userId, query: input.query, limit: 40 })
    const scoreByKb = new Map<string, { name: string; score: number }>()
    hits.forEach((hit, index) => {
        const current = scoreByKb.get(hit.knowledgeBaseId) ?? { name: hit.knowledgeBaseName, score: 0 }
        current.score += hits.length - index
        scoreByKb.set(hit.knowledgeBaseId, current)
    })
    const ranked = [...scoreByKb.entries()]
        .sort((left, right) => right[1].score - left[1].score)
        .slice(0, MAX_PARALLEL_KBS)
        .map(([id, value]) => ({ id: Number(id), name: value.name }))
    if (ranked.length > 0) return ranked

    // 兜底：Wiki 尚未编译、关键词无命中时，取前若干个库让子 Agent 用目录树/源文档兜底检索。
    return owned.slice(0, MAX_PARALLEL_KBS).map((kb) => ({ id: Number(kb.id), name: kb.name }))
}

function buildSubagentSystemPrompt(kbName: string) {
    return [
        `你是知识库《${kbName}》的检索子 Agent，只在本知识库范围内工作。`,
        "1. 先用 search_document_tree（推理式）或 semantic_search_tree（语义）在目录树上定位与问题最相关的章节；命中不足时用 search_wiki_pages，必要时 read_wiki_page / read_source_article 读全文核验。",
        "2. 最终用 3-8 句中文给出**仅基于本知识库**的结论，并在结论里点明引用了哪篇文档（文章标题）。",
        "3. 如果本知识库确实没有相关内容，直接回答「本知识库无相关内容」，不要编造。",
        "4. 只输出结论正文，不要寒暄，也不要调用任何展示类工具。",
    ].join("\n")
}

function describeToolInput(toolName: string, rawInput: unknown): string {
    const input = asToolInputRecord(rawInput)
    if (!input) return ""
    if (typeof input.query === "string") return input.query
    if (typeof input.pageKey === "string") return input.pageKey
    if (typeof input.nodeKey === "string") return input.nodeKey
    if (input.articleId != null) return `文章 #${String(input.articleId)}`
    void toolName
    return ""
}

function asToolInputRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

// 从子 Agent 各检索工具的输出里抽取 { articleId, title } 拼成本库引用，按 articleId 去重。
function collectCitationsFromToolOutput(entry: KbResearchProgress, kb: { id: number; name: string }, output: unknown) {
    const records = normalizeToolOutputRecords(output)
    for (const record of records) {
        const articleId = record.articleId
        const title = typeof record.title === "string" ? record.title : null
        if (articleId == null || articleId === "" || !title) continue
        const articleIdText = String(articleId)
        if (entry.citations.some((citation) => citation.id === `${entry.knowledgeBaseId}:${articleIdText}`)) continue
        const href = typeof record.href === "string" && record.href
            ? record.href
            : knowledgeBaseArticlePath(entry.knowledgeBaseId, articleIdText)
        entry.citations.push({
            id: `${entry.knowledgeBaseId}:${articleIdText}`,
            href,
            title,
            snippet: typeof record.summary === "string" ? record.summary : undefined,
            domain: kb.name,
            type: "article",
        })
    }
}

function normalizeToolOutputRecords(output: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(output)) {
        return output.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    }
    if (typeof output === "object" && output !== null) {
        const record = output as Record<string, unknown>
        if (Array.isArray(record.hits)) {
            return record.hits.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        }
        return [record]
    }
    return []
}

function snapshotDeepResearch(query: string, progress: KbResearchProgress[]): DeepResearchResult {
    const kbs = progress.map((entry) => ({
        ...entry,
        steps: entry.steps.slice(),
        citations: entry.citations.slice(),
    }))
    const merged: DeepResearchCitation[] = []
    const seen = new Set<string>()
    for (const kb of kbs) {
        for (const citation of kb.citations) {
            if (seen.has(citation.id)) continue
            seen.add(citation.id)
            merged.push(citation)
        }
    }
    return { query, kbs, citations: merged }
}

// 子 Agent token 用量聚合：单独统计，不并入编排器 usage（后者驱动上下文占用条，须反映真实上下文占用）。
type SubAgentUsageSummary = {
    calls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens?: number
    cachedInputTokens?: number
}

type SubAgentUsageAccumulator = {
    calls: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens: number
    cachedInputTokens: number
}

function createSubAgentUsageAccumulator(): SubAgentUsageAccumulator {
    return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }
}

function addSubAgentUsage(acc: SubAgentUsageAccumulator, usage: AssistantUsageSource | undefined) {
    acc.calls += 1
    if (!usage) return
    const inputTokens = numberOrZero(usage.inputTokens)
    const outputTokens = numberOrZero(usage.outputTokens)
    acc.inputTokens += inputTokens
    acc.outputTokens += outputTokens
    acc.totalTokens += numberOrZero(usage.totalTokens) || inputTokens + outputTokens
    acc.reasoningTokens += numberOrZero(usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens)
    acc.cachedInputTokens += numberOrZero(usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens)
}

function summarizeSubAgentUsage(acc: SubAgentUsageAccumulator): SubAgentUsageSummary | undefined {
    if (acc.calls === 0) return undefined
    return {
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        totalTokens: acc.totalTokens,
        ...(acc.reasoningTokens > 0 ? { reasoningTokens: acc.reasoningTokens } : {}),
        ...(acc.cachedInputTokens > 0 ? { cachedInputTokens: acc.cachedInputTokens } : {}),
    }
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
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
