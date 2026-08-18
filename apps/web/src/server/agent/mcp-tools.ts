import { z } from "zod"
import type { AgentApiKeyScope } from "@/server/agent/api-key"
import { buildAgentEndpointMap } from "@/server/agent/skill"

// MCP 工具与 REST 能力层一一对应：本文件只放纯规格与转换逻辑（可单测），
// 真实 handler 接线在 mcp.ts，避免测试环境拉起 better-auth / 数据库依赖。

const endpoints = buildAgentEndpointMap()

const idInputSchema = z.union([z.string(), z.number()])

export type AgentMcpToolSpec = {
    name: string
    title: string
    description: string
    scope: AgentApiKeyScope
    endpointPath: string
    inputSchema: z.ZodRawShape
}

export const AGENT_MCP_TOOL_SPECS = [
    {
        name: "list_knowledge_bases",
        title: "列出知识库",
        description: "列出当前 API Key 所属用户的全部知识库（id、名称、描述）。通常作为第一步，用来确定后续工具需要的 knowledgeBaseId。",
        scope: "doc:read",
        endpointPath: endpoints.knowledgeBaseList,
        inputSchema: {},
    },
    {
        name: "get_knowledge_base_tree",
        title: "查看知识库目录树",
        description: "查看指定知识库的完整目录树（文件夹与文章节点，含 articleId），用于浏览结构或为新文章挑选父文件夹。",
        scope: "doc:read",
        endpointPath: endpoints.knowledgeBaseTree,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
        },
    },
    {
        name: "search_documents",
        title: "关键词搜索文档",
        description: "按关键词搜索文档（Wiki 页面与源文章的标题/正文）。不传 knowledgeBaseId 时跨全部知识库搜索。返回标题、摘要与定位信息（articleId / pageKey）。",
        scope: "doc:read",
        endpointPath: endpoints.documentSearch,
        inputSchema: {
            query: z.string().min(1).max(200).describe("搜索关键词"),
            knowledgeBaseId: idInputSchema.optional().describe("可选：限定单个知识库"),
            limit: z.number().int().min(1).max(20).optional().describe("返回条数上限，默认 8"),
        },
    },
    {
        name: "search_document_tree",
        title: "章节树推理检索",
        description: "推理式检索：在指定知识库的文档章节目录树上定位与问题最相关的章节，返回面包屑路径、摘要与原文片段（含 articleId 与 nodeKey）。回答细节性问题时优先使用它，比关键词搜索更精准。",
        scope: "doc:read",
        endpointPath: endpoints.documentTree,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            query: z.string().min(1).max(200).describe("要检索的问题或关键词"),
            limit: z.number().int().min(1).max(12).optional().describe("返回章节数上限，默认 6"),
            articleId: idInputSchema.optional().describe("可选：限定在单篇文章内检索"),
        },
    },
    {
        name: "semantic_search_document_tree",
        title: "章节树语义检索",
        description: "向量语义检索：对章节节点做向量相似度召回，适合近义/概念性表述或关键词检索召回不佳时。需要服务端已配置 PostgreSQL 与向量模型，不可用时请改用 search_document_tree。",
        scope: "doc:read",
        endpointPath: endpoints.documentSemanticSearch,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            query: z.string().min(1).max(200).describe("要检索的问题或关键词"),
            limit: z.number().int().min(1).max(12).optional().describe("返回章节数上限，默认 6"),
            articleId: idInputSchema.optional().describe("可选：限定在单篇文章内检索"),
        },
    },
    {
        name: "view_document",
        title: "读取文档全文",
        description: "读取完整文档内容（Markdown）。两种用法：只传 articleId 读源文章；或同时传 knowledgeBaseId 与 pageKey 读 Wiki 页面。",
        scope: "doc:read",
        endpointPath: endpoints.documentView,
        inputSchema: {
            articleId: idInputSchema.optional().describe("源文章 ID（与 knowledgeBaseId+pageKey 二选一）"),
            knowledgeBaseId: idInputSchema.optional().describe("知识库 ID（读 Wiki 页面时与 pageKey 一起传）"),
            pageKey: z.string().min(1).max(200).optional().describe("Wiki 页面 Key"),
        },
    },
    {
        name: "ask_documents",
        title: "文档问答",
        description: "基于文档上下文的一次性问答：服务端自动检索相关文档并调用模型生成答案，返回答案与引用。会产生模型调用费用；需要自行推理或多步检索时改用检索类工具。",
        scope: "qa:read",
        endpointPath: endpoints.documentQa,
        inputSchema: {
            question: z.string().min(1).max(1000).describe("要提问的问题"),
            knowledgeBaseId: idInputSchema.optional().describe("可选：限定单个知识库"),
            limit: z.number().int().min(1).max(10).optional().describe("检索上下文条数上限，默认 6"),
        },
    },
    {
        name: "list_articles",
        title: "列出文章",
        description: "按条件列出指定知识库内的文章（支持标题关键词、标签、父文件夹过滤），返回文章 ID、标题、标签与路径。",
        scope: "doc:read",
        endpointPath: endpoints.articleList,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            keyword: z.string().max(200).optional().describe("标题关键词过滤"),
            tags: z.array(z.string().min(1).max(40)).max(50).optional().describe("标签过滤（须全部命中）"),
            parentId: idInputSchema.optional().describe("父文件夹节点 ID，不传表示不过滤"),
            limit: z.number().int().min(1).max(200).optional().describe("返回条数上限，默认 50"),
        },
    },
    {
        name: "create_folder",
        title: "新建文件夹",
        description: "在指定知识库中新建文件夹，可通过 parentId 指定父文件夹（不传则在根目录创建）。",
        scope: "article:write",
        endpointPath: endpoints.folderCreate,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            name: z.string().min(1).max(200).describe("文件夹名称"),
            parentId: idInputSchema.optional().describe("可选：父文件夹节点 ID"),
        },
    },
    {
        name: "create_article",
        title: "新建文章",
        description: "在指定知识库中新建 Markdown 文章，可指定父文件夹与标签，返回新文章的 articleId。",
        scope: "article:write",
        endpointPath: endpoints.articleCreate,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            title: z.string().min(1).max(200).describe("文章标题"),
            contentMd: z.string().min(1).describe("Markdown 正文"),
            parentId: idInputSchema.optional().describe("可选：父文件夹节点 ID"),
            tags: z.array(z.string().min(1).max(40)).max(50).optional().describe("可选：文章标签"),
        },
    },
    {
        name: "update_article",
        title: "更新文章",
        description: "更新文章的标题、正文与标签。注意 contentMd 是全量覆盖：请先用 view_document 读取原文，在其基础上修改后整体提交，避免丢内容。",
        scope: "article:write",
        endpointPath: endpoints.articleUpdate,
        inputSchema: {
            articleId: idInputSchema.describe("文章 ID"),
            title: z.string().min(1).max(200).describe("文章标题"),
            contentMd: z.string().min(1).describe("Markdown 正文（全量覆盖）"),
            tags: z.array(z.string().min(1).max(40)).max(50).optional().describe("可选：文章标签（全量覆盖）"),
        },
    },
    {
        name: "delete_article",
        title: "删除文章",
        description: "删除指定文章（不可恢复）。删除前必须向用户复述文章 ID 与标题，并获得明确确认。",
        scope: "article:delete",
        endpointPath: endpoints.articleDelete,
        inputSchema: {
            articleId: idInputSchema.describe("文章 ID"),
        },
    },
    {
        name: "move_article",
        title: "移动文章",
        description: "把文章移动到目标文件夹（parentId 不传表示移到根目录），可用 targetIndex 指定排序位置。",
        scope: "article:write",
        endpointPath: endpoints.articleMove,
        inputSchema: {
            articleId: idInputSchema.describe("文章 ID"),
            parentId: idInputSchema.optional().describe("目标父文件夹节点 ID，不传表示根目录"),
            targetIndex: z.number().int().min(0).optional().describe("可选：目标位置（从 0 开始）"),
        },
    },
    {
        name: "list_wiki_pages",
        title: "列出 Wiki 页面",
        description: "列出指定知识库 Wiki 编译层的全部页面（pageKey、标题、摘要），用于纵览知识库沉淀内容。",
        scope: "wiki:read",
        endpointPath: endpoints.wikiPageList,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
        },
    },
    {
        name: "read_wiki_page",
        title: "读取 Wiki 页面",
        description: "读取指定知识库内某个 Wiki 页面的完整内容与引用来源。",
        scope: "wiki:read",
        endpointPath: endpoints.wikiPageDetail,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            pageKey: z.string().min(1).max(200).describe("Wiki 页面 Key"),
        },
    },
    {
        name: "wiki_lint",
        title: "Wiki 体检",
        description: "检查指定知识库 Wiki 是否存在缺失引用、断链、孤立页面等维护问题。",
        scope: "wiki:read",
        endpointPath: endpoints.wikiLint,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
        },
    },
    {
        name: "wiki_ingest",
        title: "编译 Wiki",
        description: "把指定知识库的文章编译/增量更新为 Wiki 中间层（含目录树索引）。当 Wiki 尚未建立或明显过期时使用；forceRebuild 会忽略缓存重新编译所有文章，耗时较长；fullRebuild 会先清空该知识库已有 Wiki（含问答沉淀页）再从零编译，属于破坏性操作，只在用户明确要求完全重建时使用。",
        scope: "wiki:write",
        endpointPath: endpoints.wikiIngest,
        inputSchema: {
            knowledgeBaseId: idInputSchema.describe("知识库 ID"),
            forceRebuild: z.boolean().optional().describe("是否忽略缓存重新编译，默认 false"),
            fullRebuild: z.boolean().optional().describe("是否完全重建（先清空已有 Wiki 再编译），默认 false"),
        },
    },
    {
        name: "share_article",
        title: "创建/更新文章分享",
        description: "为文章创建（或更新）公开分享链接，可设置 6 位数字访问密码与过期时间，返回 shareUrl。开启密码或设置过期时间前建议先用 get_article_share 查看当前状态。",
        scope: "share:write",
        endpointPath: endpoints.articleShareCreate,
        inputSchema: {
            articleId: idInputSchema.describe("文章 ID"),
            passwordEnabled: z.boolean().optional().describe("是否启用访问密码"),
            accessPassword: z.string().regex(/^\d{6}$/).optional().describe("6 位数字访问密码（启用密码时提供）"),
            expiresAt: z.string().optional().describe("可选：过期时间（ISO 8601，如 2026-12-31T23:59:59Z）"),
        },
    },
    {
        name: "get_article_share",
        title: "查询文章分享状态",
        description: "查询文章当前的分享状态（是否启用、shareUrl、是否有密码、过期时间）。",
        scope: "share:write",
        endpointPath: endpoints.articleShareInfo,
        inputSchema: {
            articleId: idInputSchema.describe("文章 ID"),
        },
    },
    {
        name: "revoke_article_share",
        title: "撤销文章分享",
        description: "撤销文章的公开分享链接。撤销前必须向用户确认。",
        scope: "share:write",
        endpointPath: endpoints.articleShareRevoke,
        inputSchema: {
            articleId: idInputSchema.describe("文章 ID"),
        },
    },
] as const satisfies readonly AgentMcpToolSpec[]

export type AgentMcpToolName = typeof AGENT_MCP_TOOL_SPECS[number]["name"]

export type AgentMcpToolResult = {
    content: Array<{ type: "text"; text: string }>
    isError?: boolean
}

const MAX_ERROR_TEXT_LENGTH = 2000

export function buildAgentMcpDelegateHeaders(input: {
    token: string
    toolName: string
    clientUserAgent?: string | null
    forwardedFor?: string | null
}): Record<string, string> {
    const userAgent = input.clientUserAgent?.trim()
        ? `petrichor-mcp/${input.toolName} ${input.clientUserAgent.trim()}`
        : `petrichor-mcp/${input.toolName}`
    return {
        "authorization": `Bearer ${input.token}`,
        "content-type": "application/json",
        "user-agent": userAgent,
        ...(input.forwardedFor?.trim() ? { "x-forwarded-for": input.forwardedFor.trim() } : {}),
    }
}

export function toAgentMcpToolResult(status: number, bodyText: string): AgentMcpToolResult {
    if (status >= 200 && status < 300) {
        return {
            content: [{ type: "text", text: bodyText.trim() || "{}" }],
        }
    }
    return {
        isError: true,
        content: [{ type: "text", text: `请求失败（HTTP ${status}）：${extractAgentErrorMessage(bodyText) ?? clipText(bodyText)}` }],
    }
}

export function missingAgentMcpTokenResult(): AgentMcpToolResult {
    return {
        isError: true,
        content: [{
            type: "text",
            text: "缺少 API Key：请在 MCP 客户端为该服务器配置请求头 Authorization: Bearer <ptc_live_...>（API Key 在 Petrichor 账号设置中生成）。",
        }],
    }
}

function extractAgentErrorMessage(bodyText: string): string | null {
    try {
        const parsed = JSON.parse(bodyText) as { msg?: unknown }
        return typeof parsed?.msg === "string" && parsed.msg.trim() ? parsed.msg : null
    } catch {
        return null
    }
}

function clipText(value: string) {
    const text = value.trim() || "未知错误"
    if (text.length <= MAX_ERROR_TEXT_LENGTH) return text
    return `${text.slice(0, MAX_ERROR_TEXT_LENGTH)}…`
}
