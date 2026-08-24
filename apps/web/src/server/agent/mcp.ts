import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { AppRequest } from "@/server/http/request"
import { authenticateAgentRequest } from "@/server/agent/api-key"
import {
    agentAskDocument,
    agentCreateArticle,
    agentCreateFolder,
    agentDeleteArticle,
    agentKnowledgeBaseTree,
    agentListArticles,
    agentListKnowledgeBases,
    agentMoveArticle,
    agentRetrieveDocumentTree,
    agentSearchDocuments,
    agentSemanticSearchDocumentTree,
    agentShareCreate,
    agentShareInfo,
    agentShareRevoke,
    agentUpdateArticle,
    agentViewDocument,
    agentWikiIngest,
    agentWikiLint,
    agentWikiPageDetail,
    agentWikiPageList,
} from "@/server/agent/handlers"
import {
    AGENT_MCP_TOOL_SPECS,
    buildAgentMcpDelegateHeaders,
    missingAgentMcpTokenResult,
    toAgentMcpToolResult,
    type AgentMcpToolName,
    type AgentMcpToolResult,
    type AgentMcpToolSpec,
} from "@/server/agent/mcp-tools"

export const AGENT_MCP_SERVER_NAME = "petrichor"
export const AGENT_MCP_SERVER_VERSION = "2026-07-02"

export const AGENT_MCP_SERVER_INSTRUCTIONS = [
    "Petrichor 个人知识库 MCP Server：检索、阅读、写入用户的知识库与文章。",
    "检索策略：回答文档细节问题时优先 search_document_tree（章节级推理检索）；近义/概念性表述用 semantic_search_document_tree；跨库粗扫用 search_documents；命中片段不足时用 view_document / read_wiki_page 读全文。",
    "写入策略：update_article 是全量覆盖，改前先 view_document 读原文。",
    "危险操作：delete_article、revoke_article_share 必须先向用户复述目标并获得明确确认。",
    "所有工具都要求 API Key 具备对应 scope，权限不足会返回 403。",
].join("\n")

type AgentRestHandler = (request: AppRequest) => Promise<Response>

// 每个 MCP 工具委托到对应的 REST handler，鉴权 / scope 校验 / 审计日志全部复用现有实现。
const AGENT_MCP_TOOL_HANDLERS: Record<AgentMcpToolName, AgentRestHandler> = {
    list_knowledge_bases: agentListKnowledgeBases,
    get_knowledge_base_tree: agentKnowledgeBaseTree,
    search_documents: agentSearchDocuments,
    search_document_tree: agentRetrieveDocumentTree,
    semantic_search_document_tree: agentSemanticSearchDocumentTree,
    view_document: agentViewDocument,
    ask_documents: agentAskDocument,
    list_articles: agentListArticles,
    create_folder: agentCreateFolder,
    create_article: agentCreateArticle,
    update_article: agentUpdateArticle,
    delete_article: agentDeleteArticle,
    move_article: agentMoveArticle,
    list_wiki_pages: agentWikiPageList,
    read_wiki_page: agentWikiPageDetail,
    wiki_lint: agentWikiLint,
    wiki_ingest: agentWikiIngest,
    share_article: agentShareCreate,
    get_article_share: agentShareInfo,
    revoke_article_share: agentShareRevoke,
}

type AgentMcpAuthExtra = {
    origin: string
    userId: number
    userAgent: string | null
    forwardedFor: string | null
}

export async function verifyAgentMcpToken(request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
    const token = bearerToken?.trim()
    if (!token) return undefined

    const origin = resolveRequestOrigin(request)
    try {
        const context = await authenticateAgentRequest(new AppRequest(`${origin}/api/mcp`, {
            headers: { authorization: `Bearer ${token}` },
        }))
        return {
            token,
            clientId: context.apiKey.keyPrefix,
            scopes: context.scopes,
            extra: {
                origin,
                userId: context.userId,
                userAgent: request.headers.get("user-agent"),
                forwardedFor: request.headers.get("x-forwarded-for"),
            } satisfies AgentMcpAuthExtra,
        }
    } catch {
        return undefined
    }
}

export function registerAgentMcpTools(server: McpServer) {
    for (const spec of AGENT_MCP_TOOL_SPECS) {
        server.registerTool(
            spec.name,
            {
                title: spec.title,
                description: spec.description,
                inputSchema: spec.inputSchema,
            },
            async (args: Record<string, unknown>, extra: { authInfo?: AuthInfo }) => await delegateAgentMcpToolCall({
                spec,
                handler: AGENT_MCP_TOOL_HANDLERS[spec.name],
                args: args ?? {},
                authInfo: extra.authInfo,
            }),
        )
    }
}

export async function delegateAgentMcpToolCall(input: {
    spec: AgentMcpToolSpec
    handler: AgentRestHandler
    args: Record<string, unknown>
    authInfo: AuthInfo | undefined
}): Promise<AgentMcpToolResult> {
    const token = input.authInfo?.token?.trim()
    if (!token) return missingAgentMcpTokenResult()

    const extra = (input.authInfo?.extra ?? {}) as Partial<AgentMcpAuthExtra>
    const origin = typeof extra.origin === "string" && extra.origin ? extra.origin : "http://127.0.0.1"
    const request = new AppRequest(`${origin}${input.spec.endpointPath}`, {
        method: "POST",
        headers: buildAgentMcpDelegateHeaders({
            token,
            toolName: input.spec.name,
            clientUserAgent: typeof extra.userAgent === "string" ? extra.userAgent : null,
            forwardedFor: typeof extra.forwardedFor === "string" ? extra.forwardedFor : null,
        }),
        body: JSON.stringify(input.args ?? {}),
    })

    const response = await input.handler(request)
    return toAgentMcpToolResult(response.status, await response.text())
}

function resolveRequestOrigin(request: Request) {
    try {
        const origin = new URL(request.url).origin
        return origin && origin !== "null" ? origin : "http://127.0.0.1"
    } catch {
        return "http://127.0.0.1"
    }
}
