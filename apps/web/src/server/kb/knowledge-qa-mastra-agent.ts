import { Agent } from "@mastra/core/agent"
import { PromptInjectionDetector, TokenLimiterProcessor } from "@mastra/core/processors"
import { createSkill, type InlineSkill } from "@mastra/core/skills"
import { createTool } from "@mastra/core/tools"
import type { LanguageModel } from "ai"
import { z } from "zod"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import {
    createAgentArtifact,
    idSchema,
    ingestKnowledgeBaseWiki,
    listUserKnowledgeBases,
    proposeWikiPatchFromAgent,
    readSourceArticleForAgent,
    readWikiPageForAgent,
    runWikiLint,
    searchWikiPagesAcrossKbs,
    searchWikiPagesForAgent,
} from "@/server/kb/wiki-agent-logic"
import { readTreeNodeForAgent, retrieveTreeNodesForAgent, semanticSearchTreeNodes } from "@/server/kb/wiki-tree"

const citationToolSchema = z.object({
    citations: z.array(z.object({
        id: z.string().min(1),
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

const retrievalSkill = createSkill({
    name: "kb-retrieval-strategy",
    description: "Use for Petrichor in-site knowledge QA retrieval planning and evidence selection.",
    instructions: `
## 目标
用最少但足够可靠的读取动作回答知识库问题，优先命中章节级证据，再补全文。

## 检索顺序
1. 细节型、解释型、定位型问题默认先用 search_document_tree。
2. 用户表达偏概念、近义、口语化，或 search_document_tree 结果稀疏时，补用 semantic_search_tree。
3. 需要看完整上下文、媒体、子章节或截断片段时，读 read_tree_node；仍不足时读 read_wiki_page。
4. 只有 Wiki/树证据不足、需要核验原文、或用户要看图片/附件时，才读 read_source_article。
5. read_wiki_index 只用于全局概览、判断知识库结构、或索引缺失后的兜底。

## 质量门槛
- 每个事实性结论至少能回指到一个工具结果中的 title/pageKey/articleId/nodeKey。
- 证据冲突时先说明冲突，不要调和成看似确定的结论。
- 没检索到就说未找到，给出下一步可验证路径，不要编造。
`,
    references: {
        "retrieval-checklist.md": [
            "# Retrieval Checklist",
            "- Start with chapter-tree retrieval for substantive document questions.",
            "- Add semantic retrieval when wording mismatch is likely.",
            "- Read full nodes/pages when snippets are incomplete.",
            "- Escalate to source articles only for verification, gaps, or media.",
        ].join("\n"),
    },
})

const citationMediaSkill = createSkill({
    name: "citation-media-policy",
    description: "Use for citation cards, source paths, and media rendering in Petrichor QA answers.",
    instructions: `
## 引用规则
1. 最终答案涉及文档内容时，要给出依据；适合时调用 show_citations。
2. href 优先使用检索/读取工具返回值；没有时用 /dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>。
3. 禁止生成 /document/<id>。
4. title 写页面或文章标题，domain 写知识库名。

## 媒体规则
当用户要查看或下载图片、架构图、截图、图表、视频、音频或附件时，必须检查 read_wiki_page / read_source_article 返回的 media。
- image: 独立段落输出 ![说明](src)
- video: 独立段落输出 <video src="src" />
- audio: 独立段落输出 <audio src="src" />
- file: 独立段落输出 <file src="src" name="文件名" />
src 必须原样使用 media.src，不要只给对象路径或只让用户点引用卡片。
`,
})

const crossKbResearchSkill = createSkill({
    name: "cross-kb-research-strategy",
    description: "Use for cross-knowledge-base research, candidate selection, and answer synthesis.",
    instructions: `
## 何时使用
用户问题需要综合多个知识库内容、比较多个资料源、或没有指定知识库时，优先使用 deep_research_kbs。

## 综合方法
1. 默认让 deep_research_kbs 自动选择候选库；只有用户明确点名知识库时才传 knowledgeBaseIds。
2. 忽略 findings 为“本知识库无相关内容”的库。
3. 合成答案时逐条标明来自哪个知识库。
4. 不同知识库结论冲突时，用“差异/可能原因/需要核验”的结构呈现。
5. show_citations 直接使用 deep_research_kbs 返回的 citations，避免二次拼错链接。
`,
})

const wikiMaintenanceSkill = createSkill({
    name: "wiki-maintenance-policy",
    description: "Use for deciding when to propose Wiki patches, tables, artifacts, and maintenance actions.",
    instructions: `
## Wiki 回写判断
单库问答每轮结束都要评估是否值得提交 propose_wiki_patch。满足任一条件就提交待审批补丁：
- Wiki 缺少该主题页面。
- 现有页面过时、不完整、或与源文档有出入。
- 本轮综合多个来源形成了 Wiki 尚未记录的结论。

## 输出产物
- 对比、矩阵、清单类结果优先 show_data_table。
- 可复用的最终答案、报告、时间线或笔记调用 save_answer_artifact。
- 不要直接声称已经写入 Wiki；propose_wiki_patch 只是待用户审批。
`,
})

const singleKbSkills = [retrievalSkill, citationMediaSkill, wikiMaintenanceSkill]
const globalKbSkills = [crossKbResearchSkill, retrievalSkill, citationMediaSkill]

type AgentModelConfig = ConstructorParameters<typeof Agent>[0]["model"]
type AgentInstructions = ConstructorParameters<typeof Agent>[0]["instructions"]
type ProcessorModel = ConstructorParameters<typeof PromptInjectionDetector>[0]["model"]

// 多步循环 + 并行子 Agent 会把同一段巨型系统提示反复整段发送。给「大而不变」的静态前缀
// 打上 Anthropic prompt-cache 断点，让其被缓存并跨步骤/跨子 Agent 复用，显著降低重复输入 token。
// 动态部分（memorySection）单独作为未缓存的 system message 追加在后面，避免让缓存前缀失效。
// 对不认识该字段的 provider（如 OpenAI 走自动前缀缓存）无副作用，会被忽略。
const CACHE_CONTROL_EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" as const } } }

function cachedSystem(content: string) {
    return { role: "system" as const, content, providerOptions: CACHE_CONTROL_EPHEMERAL }
}

function plainSystem(content: string) {
    return { role: "system" as const, content }
}

// 多步工具循环里 read_source_article / read_wiki_page 会把整篇文档灌进上下文，maxSteps 高达 8，
// 连读几篇长文会让后续每一步输入雪球式膨胀。用 TokenLimiterProcessor 作为输入处理器，在进入循环前
// 及每一步裁掉最老消息（保留 system），保证上下文有安全上限。此值是「安全天花板」，请按实际模型上下文窗口调。
const MAX_CONTEXT_TOKENS = 100_000

// 主编排 Agent 的输入处理器：先做提示注入/越狱检测（只查最新一条用户消息，避免多算历史），
// 再做上下文 token 裁剪。注意：这里只防「用户消息」层面的越狱，源文档内容经工具结果回灌属另一层面。
function buildMainAgentInputProcessors(model: LanguageModel) {
    return [
        new PromptInjectionDetector({
            model: model as unknown as ProcessorModel,
            strategy: "block",
            threshold: 0.85,
            detectionTypes: ["injection", "jailbreak", "system-override"],
            lastMessageOnly: true,
        }),
        new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" }),
    ]
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

export function createKnowledgeQaMastraAgent(input: {
    userId: number
    knowledgeBaseId: number | null
    threadId: number
    runId: number
    model: LanguageModel
    memorySection?: string | null
    onSubagentUsage?: (usage: AssistantUsageSource | undefined) => void
}) {
    const scopedKnowledgeBaseId = input.knowledgeBaseId
    const scoped = scopedKnowledgeBaseId != null
    const tools = scoped
        ? buildKnowledgeAgentTools({
            userId: input.userId,
            knowledgeBaseId: scopedKnowledgeBaseId,
            threadId: input.threadId,
            runId: input.runId,
        })
        : buildGlobalAgentTools({
            userId: input.userId,
            threadId: input.threadId,
            runId: input.runId,
            model: input.model,
            onSubagentUsage: input.onSubagentUsage,
        })
    const skills = scoped ? singleKbSkills : globalKbSkills
    const instructions = scoped
        ? buildAgentSystemPrompt(input.memorySection, skills)
        : buildGlobalAgentSystemPrompt(input.memorySection, skills)

    return {
        agent: new Agent({
            id: scoped ? "petrichor-knowledge-qa" : "petrichor-global-knowledge-qa",
            name: scoped ? "Petrichor Knowledge QA" : "Petrichor Global Knowledge QA",
            description: scoped
                ? "In-site single knowledge-base document QA agent."
                : "In-site cross-knowledge-base document QA agent.",
            model: input.model as unknown as AgentModelConfig,
            instructions,
            tools,
            // 不再把 skills 传给 Agent：传了会自动注入 skill 索引并挂上 skill/skill_read/skill_search 三个工具，
            // 而我们已用 buildPreloadedSkillSection 把 skill 全文内联进 instructions，再传就是双重注入 + 多挂被禁用的工具。
            // createSkill 对象在这里只当作结构化文本容器（供 buildPreloadedSkillSection 内联）使用。
            inputProcessors: buildMainAgentInputProcessors(input.model),
        }),
        activeToolNames: Object.keys(tools),
    }
}

function buildKnowledgeAgentTools(context: {
    userId: number
    knowledgeBaseId: number
    threadId: number
    runId: number
}) {
    return {
        show_progress: createTool({
            id: "show_progress",
            description: "展示当前阅读、分析、校验或写入 Wiki 的执行进度。",
            inputSchema: progressToolSchema,
            execute: async (input) => ({
                id: `progress-${Date.now()}`,
                title: input.title,
                description: input.description,
                steps: input.steps,
            }),
        }),
        compile_wiki: createTool({
            id: "compile_wiki",
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
        show_citations: createTool({
            id: "show_citations",
            description: "把最终答案使用的 Wiki 页面或源文档引用渲染为引用卡片。href 必须优先使用检索/读取工具返回的 href，或按 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>` 生成，禁止使用 `/document/<id>`。",
            inputSchema: citationToolSchema,
            execute: async ({ citations }) => ({
                id: `citations-${Date.now()}`,
                citations,
                variant: "default" as const,
            }),
        }),
        show_data_table: createTool({
            id: "show_data_table",
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
        propose_wiki_patch: createTool({
            id: "propose_wiki_patch",
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
        save_answer_artifact: createTool({
            id: "save_answer_artifact",
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
        run_wiki_lint: createTool({
            id: "run_wiki_lint",
            description: "检查 Wiki 是否存在缺失引用、断链、孤立页面等维护问题。",
            inputSchema: z.object({}),
            execute: async () => await runWikiLint(context.userId, context.knowledgeBaseId),
        }),
    }
}

function buildGlobalAgentTools(context: {
    userId: number
    threadId: number
    runId: number
    model: LanguageModel
    onSubagentUsage?: (usage: AssistantUsageSource | undefined) => void
}) {
    return {
        show_progress: createTool({
            id: "show_progress",
            description: "展示当前检索、阅读、分析的执行进度。",
            inputSchema: progressToolSchema,
            execute: async (input) => ({
                id: `progress-${Date.now()}`,
                title: input.title,
                description: input.description,
                steps: input.steps,
            }),
        }),
        list_knowledge_bases: createTool({
            id: "list_knowledge_bases",
            description: "列出当前用户的所有知识库，用于跨库检索前的概览。",
            inputSchema: z.object({}),
            execute: async () => await listUserKnowledgeBases(context.userId),
        }),
        search_across_kbs: createTool({
            id: "search_across_kbs",
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
        deep_research_kbs: createTool({
            id: "deep_research_kbs",
            description: "跨知识库并行深度检索：自动（或按 knowledgeBaseIds 指定）挑选最相关的若干知识库，为每个库派一个 Mastra 检索子 Agent 并行深挖，返回每个库的结论（findings）与可引用来源（citations）。回答需要综合多个知识库内容的实质性问题时优先使用它，而不是自己逐库 read_wiki_page。",
            inputSchema: z.object({
                query: z.string().min(1).describe("要在各知识库中研究的问题（可在用户原问题基础上提炼得更聚焦）"),
                knowledgeBaseIds: z.array(idSchema).min(1).max(MAX_PARALLEL_KBS).optional()
                    .describe("可选：显式指定要并行检索的知识库 id；不传则根据 query 自动挑选候选库"),
            }),
            execute: async ({ query, knowledgeBaseIds }, toolContext) => await runDeepResearchAcrossKbs({
                userId: context.userId,
                model: context.model,
                query,
                knowledgeBaseIds: knowledgeBaseIds ?? null,
                abortSignal: toolContext?.abortSignal,
                onSubagentUsage: context.onSubagentUsage,
                // context.writer 让工具在执行期间把每个库的实时检索进度作为 data-deep-research part 推给前端卡片。
                writer: (toolContext as { writer?: ProgressWriter } | undefined)?.writer,
                progressId: `deep-research-${Date.now()}`,
            }),
        }),
        read_wiki_page: createTool({
            id: "read_wiki_page",
            description: "读取指定知识库内的具体 Wiki 页面。需要传 knowledgeBaseId（数字字符串）和 pageKey；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                knowledgeBaseId: idSchema,
                pageKey: z.string().min(1),
            }),
            execute: async ({ knowledgeBaseId, pageKey }) => await readWikiPageForAgent(context.userId, knowledgeBaseId, pageKey),
        }),
        read_source_article: createTool({
            id: "read_source_article",
            description: "读取指定知识库内的源文档。仅在 Wiki 信息不足或需要查看图片时使用；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                knowledgeBaseId: idSchema,
                articleId: idSchema,
            }),
            execute: async ({ knowledgeBaseId, articleId }) => await readSourceArticleForAgent(context.userId, knowledgeBaseId, articleId),
        }),
        show_citations: createTool({
            id: "show_citations",
            description: "把最终答案使用的 Wiki 页面或源文档引用渲染为引用卡片。href 必须优先使用检索/读取工具返回的 href，或按 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>` 生成，禁止使用 `/document/<id>`。",
            inputSchema: citationToolSchema,
            execute: async ({ citations }) => ({
                id: `citations-${Date.now()}`,
                citations,
                variant: "default" as const,
            }),
        }),
        show_data_table: createTool({
            id: "show_data_table",
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
        save_answer_artifact: createTool({
            id: "save_answer_artifact",
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

function buildKbRetrievalTools(context: {
    userId: number
    knowledgeBaseId: number
}) {
    return {
        read_wiki_index: createTool({
            id: "read_wiki_index",
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
        search_document_tree: createTool({
            id: "search_document_tree",
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
        semantic_search_tree: createTool({
            id: "semantic_search_tree",
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
        read_tree_node: createTool({
            id: "read_tree_node",
            description: "读取目录树中某个章节节点的完整内容（含面包屑路径、子节点与媒体引用）。当 search_document_tree 返回的片段被截断、需要看全文时使用，传 nodeKey。",
            inputSchema: z.object({
                nodeKey: z.string().min(1),
            }),
            execute: async ({ nodeKey }) => {
                const node = await readTreeNodeForAgent(context.userId, context.knowledgeBaseId, nodeKey)
                return node ?? { error: "目录节点不存在", nodeKey }
            },
        }),
        search_wiki_pages: createTool({
            id: "search_wiki_pages",
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
        read_wiki_page: createTool({
            id: "read_wiki_page",
            description: "读取一个具体 Wiki 页面。用于获得可引用、可回答的中间知识；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                pageKey: z.string().min(1),
            }),
            execute: async ({ pageKey }) => await readWikiPageForAgent(context.userId, context.knowledgeBaseId, pageKey),
        }),
        read_source_article: createTool({
            id: "read_source_article",
            description: "当 Wiki 页面不足以回答、需要核验原文或查看图片时读取源文档；若内容含图片/视频/音频/附件，会在 media 字段返回可直接渲染或下载的媒体引用（每项带 kind 类型）。",
            inputSchema: z.object({
                articleId: idSchema,
            }),
            execute: async ({ articleId }) => await readSourceArticleForAgent(context.userId, context.knowledgeBaseId, articleId),
        }),
    }
}

function buildAgentSystemPrompt(memorySection: string | null | undefined, skills: InlineSkill[]): AgentInstructions {
    const staticPrompt = [
        "你是 Petrichor 的文档问答 Agent，负责基于 Wiki 编译层与文档目录树回答用户问题。",
        buildPreloadedSkillSection(skills),
        "核心规则：",
        "1. 回答关于文档内容的问题时，第一步先调用 search_document_tree 在章节目录树上做推理式检索，定位最相关的章节（这是默认首选的检索方式）。",
        "1.1 树检索与 Wiki/源文档是互补关系，应按需配合：当命中片段不足、需要更完整的上下文，或要展示图片/视频/附件等媒体时，再结合 read_tree_node 读该章节全文、或 read_wiki_page / read_source_article 读整篇来补全，不要只停在树检索片段上。read_wiki_index 用于需要纵览「这个知识库里有哪些文档」时；search_wiki_pages 作为树检索不到结果时的整篇粒度兜底。",
        "1.2 当用户用近义/概念性表述提问，或 search_document_tree 推理导航召回不佳时，改用或补充 semantic_search_tree 做向量语义检索（返回结构与 search_document_tree 一致）。",
        "2. 只有目录树与 Wiki 都不足、需要核验或引用原文时，才调用 read_source_article。",
        "3. 回答必须给出依据；适合时调用 show_citations 渲染引用。引用 href 必须优先使用 search/read 工具返回的 href，或用文章详情页路径 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>`；禁止使用 `/document/<id>`。title 写「页面标题」，domain 写「知识库名」。articleId 从 search/read 工具返回的 articleId 字段获取，或从 pageKey `source-<id>` 解析。",
        "4. 涉及多步分析时可调用 show_progress 展示执行进度。",
        "5. 每次回答后都要主动评估「这次内容是否值得回写 Wiki」，满足任一条件就调用 propose_wiki_patch 提交待审批补丁：(a) Wiki 缺少该主题对应的页面；(b) 现有页面信息过时、不完整、或与源文档有出入；(c) 你综合多处来源 / 基于源文档整理出了现有 Wiki 页面尚未记录的结论。调用时必须给出：pageKey（更新填现有页面的 pageKey，新建用语义化的英文短横线 key 如 `topic-mole-cli`）、title、完整的 proposedContentMd（Markdown 正文）、reason（一句话说明为什么值得沉淀）。只提交补丁等用户审批，绝不声称已写入 Wiki。仅当内容与现有 Wiki 已基本一致、没有实质增量时才跳过，避免噪音补丁。",
        "6. 对比、矩阵、清单类结果优先调用 show_data_table。",
        "7. 可复用的最终答案调用 save_answer_artifact 保存为产物。",
        "8. 当用户需要查看或下载文档里的图片、架构图、截图、图表、视频、音频或附件时，必须查看 read_wiki_page / read_source_article 返回的 media 字段，并按每项的 media.kind 在最终答案中直接输出对应标签（src 一律使用 media.src 原值，不要只给对象路径或只让用户点击引用卡片）：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`（name 用 media.filename）。务必使用自闭合写法，不要输出 `</video>`、`</audio>`、`</file>` 等闭合标签；这些媒体标签要独立成段，不要放进表格单元格里。",
        "9. 只使用中文回答。答案要直接、结构清晰、避免编造。",
    ].join("\n")
    return [
        cachedSystem(staticPrompt),
        ...(memorySection ? [plainSystem(memorySection)] : []),
    ] as AgentInstructions
}

function buildGlobalAgentSystemPrompt(memorySection: string | null | undefined, skills: InlineSkill[]): AgentInstructions {
    const staticPrompt = [
        "你是 Petrichor 的跨知识库文档问答 Agent。本次对话覆盖用户的所有知识库。",
        buildPreloadedSkillSection(skills),
        "核心规则：",
        "1. 对于需要综合知识库内容的实质性问题，**优先调用 deep_research_kbs**（自动并行检索多个相关知识库，每个库派一个 Mastra 检索子 Agent）。它返回 kbs[]（每个库的 findings 结论）与 citations（可引用来源）。默认不传 knowledgeBaseIds 让它自动挑库；只有当用户明确点名某几个库时才传。",
        "2. 拿到 deep_research_kbs 结果后，你负责**综合各库 findings 写出统一答案**，逐条结论要明确标注来自哪个知识库；忽略 findings 为「本知识库无相关内容」的库。随后调用 show_citations 渲染引用，**直接使用返回的 citations**（其 href/title/domain 已就绪）。",
        "3. 仅当用户只是想「我有哪些知识库/做个概览」这类轻量问题时，才用 list_knowledge_bases；需要一次性关键词粗扫时可用 search_across_kbs。需要对单个库补充核验时可用 read_wiki_page / read_source_article。",
        "4. 引用 href 必须优先使用工具返回的 href；没有 href 时才按可跳转的文章详情页路径 `/dashboard/knowledge/<knowledgeBaseId>/articles/<articleId>` 生成；禁止使用 `/document/<id>`。title 写「页面标题」，domain 写「知识库名」。",
        "5. 涉及多步分析时可调用 show_progress 展示执行进度。结构化对比结果调用 show_data_table。",
        "6. 不要直接修改 Wiki；如果需要沉淀结论，请提示用户去具体知识库内提交补丁。",
        "7. 当用户需要查看或下载文档里的图片、架构图、截图、图表、视频、音频或附件时，必须查看 read_wiki_page / read_source_article 返回的 media 字段，并按每项的 media.kind 在最终答案中直接输出对应标签（src 一律使用 media.src 原值，不要只给对象路径或只让用户点击引用卡片）：image 用 `![说明](src)`；video 用自闭合 `<video src=\"src\" />`；audio 用自闭合 `<audio src=\"src\" />`；file 用自闭合 `<file src=\"src\" name=\"文件名\" />`（name 用 media.filename）。务必使用自闭合写法，不要输出 `</video>`、`</audio>`、`</file>` 等闭合标签；这些媒体标签要独立成段，不要放进表格单元格里。",
        "8. 只使用中文回答。答案要直接、结构清晰、避免编造；明确告诉用户答案来自哪个知识库。",
    ].join("\n")
    return [
        cachedSystem(staticPrompt),
        ...(memorySection ? [plainSystem(memorySection)] : []),
    ] as AgentInstructions
}

function buildPreloadedSkillSection(skills: InlineSkill[]) {
    return [
        "已预加载以下 Mastra skills；你必须把它们当作本轮工作规范执行。为保持站内 QA UI 协议稳定，不要调用 skill、skill_read、skill_search，直接按这些规则使用业务工具。",
        ...skills.map((skill) => [
            `## Skill: ${skill.name}`,
            skill.description,
            skill.instructions.trim(),
        ].join("\n")),
        "",
    ].join("\n")
}

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

type KnowledgeBaseCandidate = {
    id: number
    name: string
}

// 工具执行上下文里的流式写入器：把中间进度作为自定义 data part 推入正在进行的 agent 流。
type ProgressWriter = {
    custom: (chunk: Record<string, unknown>) => Promise<unknown>
}

// Mastra fullStream 里我们关心的工具相关分片形状（其余分片忽略）。
type SubAgentStreamChunk = {
    type?: string
    payload?: {
        toolName?: string
        args?: unknown
        result?: unknown
        isError?: boolean
    }
}

/**
 * 跨库深度检索：候选库由 selectCandidateKbs 确定性选出后，直接并行派发检索子 Agent，
 * 各库独立深挖并通过 writer.custom 实时回传进度（供前端卡片渐进渲染），最后聚合各库 findings + 去重 citations。
 * 不再经过 LLM supervisor 委派——候选库与最终综合分别由代码和顶层 QA Agent 负责，中间无需一个易漏调的协调者。
 */
async function runDeepResearchAcrossKbs(input: {
    userId: number
    model: LanguageModel
    query: string
    knowledgeBaseIds: number[] | null
    abortSignal?: AbortSignal
    onSubagentUsage?: (usage: AssistantUsageSource | undefined) => void
    writer?: ProgressWriter
    progressId?: string
}): Promise<DeepResearchResult> {
    const candidates = await selectCandidateKbs(input)
    if (candidates.length === 0) {
        return { query: input.query, kbs: [], citations: [], note: "未找到与该问题相关的知识库。" }
    }

    const progress: KbResearchProgress[] = candidates.map((kb) => ({
        knowledgeBaseId: String(kb.id),
        knowledgeBaseName: kb.name,
        status: "pending",
        steps: [],
        findings: "",
        citations: [],
    }))

    // 串行化 writer 写入：多个子 Agent 并行推进，若并发调用 writer.custom 会触发 WritableStream 锁定错误。
    const emitProgress = createProgressEmitter({
        writer: input.writer,
        progressId: input.progressId,
        query: input.query,
        progress,
    })
    await emitProgress()

    await Promise.all(candidates.map(async (kb, index) => {
        const entry = progress[index]
        entry.status = "researching"
        await emitProgress()
        let usageReported = false
        try {
            const subAgent = createKbResearchSubAgent({ userId: input.userId, model: input.model, kb })
            const stream = await subAgent.stream(buildSubagentDelegationPrompt(input.query, kb), {
                maxSteps: SUBAGENT_MAX_STEPS,
                modelSettings: { temperature: 0.2 },
                abortSignal: input.abortSignal,
            })
            // 消费子 Agent 的 fullStream，把工具调用/结果转成本库进度与引用，逐步回传给 UI。
            for await (const chunk of stream.fullStream as AsyncIterable<SubAgentStreamChunk>) {
                if (chunk.type === "tool-call") {
                    const toolName = chunk.payload?.toolName ?? "unknown"
                    pushResearchStep(entry, toolName, describeToolInput(toolName, chunk.payload?.args))
                    await emitProgress()
                } else if (chunk.type === "tool-result") {
                    if (!chunk.payload?.isError) {
                        collectCitationsFromToolOutput(entry, kb, chunk.payload?.result)
                    }
                    await emitProgress()
                }
            }
            entry.findings = (await stream.text).trim() || "本知识库无相关内容"
            entry.status = "completed"
            input.onSubagentUsage?.((await stream.usage) as AssistantUsageSource | undefined)
            usageReported = true
        } catch (error) {
            entry.status = "failed"
            entry.findings = entry.findings || `本库检索失败：${error instanceof Error ? error.message : String(error)}`
        } finally {
            if (!usageReported) input.onSubagentUsage?.(undefined)
            await emitProgress()
        }
    }))

    return snapshotDeepResearch(input.query, progress)
}

// 串行化进度发射器：每次调用推入当前合并快照，写入按调用顺序排队，避免多个子 Agent 并发锁流。
function createProgressEmitter(input: {
    writer?: ProgressWriter
    progressId?: string
    query: string
    progress: KbResearchProgress[]
}): () => Promise<void> {
    const { writer, progressId, query, progress } = input
    if (!writer) return async () => {}
    const partId = progressId ?? `deep-research-${Date.now()}`
    let chain: Promise<void> = Promise.resolve()
    return () => {
        const snapshot = snapshotDeepResearch(query, progress)
        chain = chain.then(async () => {
            try {
                // 同一个 id 的 data part 会在客户端原地更新，从而形成单张渐进刷新的卡片。
                await writer.custom({ type: "data-deep-research", id: partId, data: snapshot })
            } catch {
                // 进度回传失败不影响主检索流程，静默忽略。
            }
        })
        return chain
    }
}

function createKbResearchSubAgent(input: {
    userId: number
    model: LanguageModel
    kb: KnowledgeBaseCandidate
}) {
    const tools = buildKbRetrievalTools({
        userId: input.userId,
        knowledgeBaseId: input.kb.id,
    })
    return new Agent({
        id: `petrichor-kb-research-${input.kb.id}`,
        name: `KB Research Subagent - ${input.kb.name}`,
        description: `只负责检索知识库《${input.kb.name}》，返回本库范围内的证据化结论。`,
        model: input.model as unknown as AgentModelConfig,
        // 共享的 skill 前缀放在最前并打缓存断点：三个并行子 Agent 的这段内容完全相同，
        // 缓存后可跨子 Agent / 跨请求复用；仅与库相关的少量规则作为未缓存的后续 system message。
        instructions: [
            cachedSystem(buildPreloadedSkillSection([retrievalSkill, citationMediaSkill])),
            plainSystem(buildSubagentSystemPrompt(input.kb.name)),
        ] as AgentInstructions,
        tools,
        // 与主 Agent 同理，不再向 Agent 传 skills（避免双重注入 + 多挂被禁用的 skill 工具）。
        inputProcessors: [new TokenLimiterProcessor({ limit: MAX_CONTEXT_TOKENS, trimMode: "contiguous" })],
        defaultOptions: {
            maxSteps: SUBAGENT_MAX_STEPS,
            modelSettings: { temperature: 0.2 },
            activeTools: Object.keys(tools),
        },
    })
}

function pushResearchStep(entry: KbResearchProgress, tool: string, detail: string) {
    entry.steps.push({ tool, detail })
    if (entry.steps.length > 12) entry.steps.shift()
}

async function selectCandidateKbs(input: {
    userId: number
    query: string
    knowledgeBaseIds: number[] | null
}): Promise<Array<{ id: number; name: string }>> {
    const owned = await listUserKnowledgeBases(input.userId)
    const nameById = new Map(owned.map((kb) => [Number(kb.id), kb.name]))

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

    return owned.slice(0, MAX_PARALLEL_KBS).map((kb) => ({ id: Number(kb.id), name: kb.name }))
}

function buildSubagentDelegationPrompt(query: string, kb: KnowledgeBaseCandidate) {
    return [
        `用户问题：${query}`,
        `研究范围：只能使用知识库《${kb.name}》（id=${kb.id}）中的 Wiki、目录树和源文档。`,
        "请按你的检索规则完成研究：优先 search_document_tree，必要时补 semantic_search_tree / read_tree_node / read_wiki_page / read_source_article。",
        "最终输出 3-8 句中文结论；每条重要结论说明来自哪篇文档或页面。",
        "如果本知识库没有相关内容，直接输出「本知识库无相关内容」。",
    ].join("\n")
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
