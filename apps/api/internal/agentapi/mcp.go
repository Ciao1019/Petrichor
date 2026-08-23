// mcp.go 对照 mcp.ts / mcp-tools.ts：/api/mcp 无状态 Streamable HTTP（JSON-RPC over HTTP）。
// 不实现 SSE 流式传输（与 TS 注释一致）；tools/call 直接委托到 agentapi 内部核心函数并写入调用日志。
package agentapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

const (
	mcpServerName    = "petrichor"
	mcpServerVersion = "2026-07-02"
)

var mcpServerInstructions = strings.Join([]string{
	"Petrichor 个人知识库 MCP Server：检索、阅读、写入用户的知识库与文章。",
	"检索策略：回答文档细节问题时优先 search_document_tree（章节级推理检索）；近义/概念性表述用 semantic_search_document_tree；跨库粗扫用 search_documents；命中片段不足时用 view_document / read_wiki_page 读全文。",
	"写入策略：update_article 是全量覆盖，改前先 view_document 读原文。",
	"危险操作：delete_article、revoke_article_share 必须先向用户复述目标并获得明确确认。",
	"所有工具都要求 API Key 具备对应 scope，权限不足会返回 403。",
}, "\n")

type mcpToolSpec struct {
	name        string
	title       string
	description string
	scope       string
	endpoint    string
	inputSchema map[string]any
}

func idSchemaProp(desc string) map[string]any {
	return map[string]any{
		"anyOf": []map[string]any{
			{"type": "string"},
			{"type": "number"},
		},
		"description": desc,
	}
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func optStrProp(desc string, maxLen int) map[string]any {
	return map[string]any{"type": "string", "description": desc, "maxLength": maxLen}
}

func intProp(desc string, minV, maxV int) map[string]any {
	return map[string]any{"type": "integer", "description": desc, "minimum": minV, "maximum": maxV}
}

func tagsProp() map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 50,
		"description": "可选：文章标签"}
}

// mcpToolSpecs 核心子集：KB 列表/树、搜索、文章读写、问答。
var mcpToolSpecs = []mcpToolSpec{
	{name: "list_knowledge_bases", title: "列出知识库",
		description: "列出当前 API Key 所属用户的全部知识库（id、名称、描述）。通常作为第一步，用来确定后续工具需要的 knowledgeBaseId。",
		scope:       "doc:read", endpoint: "/api/agent/knowledge-base/list",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}}},
	{name: "get_knowledge_base_tree", title: "查看知识库目录树",
		description: "查看指定知识库的完整目录树（文件夹与文章节点，含 articleId），用于浏览结构或为新文章挑选父文件夹。",
		scope:       "doc:read", endpoint: "/api/agent/knowledge-base/tree",
		inputSchema: map[string]any{"type": "object",
			"properties": map[string]any{"knowledgeBaseId": idSchemaProp("知识库 ID")},
			"required":   []string{"knowledgeBaseId"}}},
	{name: "search_documents", title: "关键词搜索文档",
		description: "按关键词搜索文档（Wiki 页面与源文章的标题/正文）。不传 knowledgeBaseId 时跨全部知识库搜索。返回标题、摘要与定位信息（articleId / pageKey）。",
		scope:       "doc:read", endpoint: "/api/agent/document/search",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"query":           optStrProp("搜索关键词", 200),
			"knowledgeBaseId": idSchemaProp("可选：限定单个知识库"),
			"limit":           intProp("返回条数上限，默认 8", 1, 20),
		}, "required": []string{"query"}}},
	{name: "search_document_tree", title: "章节树推理检索",
		description: "推理式检索：在指定知识库的文档章节目录树上定位与问题最相关的章节。回答细节性问题时优先使用它，比关键词搜索更精准。",
		scope:       "doc:read", endpoint: "/api/agent/document/tree",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"knowledgeBaseId": idSchemaProp("知识库 ID"),
			"query":           optStrProp("要检索的问题或关键词", 200),
			"limit":           intProp("返回章节数上限，默认 6", 1, 12),
			"articleId":       idSchemaProp("可选：限定在单篇文章内检索"),
		}, "required": []string{"knowledgeBaseId", "query"}}},
	{name: "semantic_search_document_tree", title: "章节树语义检索",
		description: "向量语义检索：对章节节点做向量相似度召回，适合近义/概念性表述或关键词检索召回不佳时。需要服务端已配置向量模型。",
		scope:       "doc:read", endpoint: "/api/agent/document/semantic-search",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"knowledgeBaseId": idSchemaProp("知识库 ID"),
			"query":           optStrProp("要检索的问题或关键词", 200),
			"limit":           intProp("返回章节数上限，默认 6", 1, 12),
			"articleId":       idSchemaProp("可选：限定在单篇文章内检索"),
		}, "required": []string{"knowledgeBaseId", "query"}}},
	{name: "view_document", title: "读取文档全文",
		description: "读取完整文档内容（Markdown）。两种用法：只传 articleId 读源文章；或同时传 knowledgeBaseId 与 pageKey 读 Wiki 页面。",
		scope:       "doc:read", endpoint: "/api/agent/document/view",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"articleId":       idSchemaProp("源文章 ID（与 knowledgeBaseId+pageKey 二选一）"),
			"knowledgeBaseId": idSchemaProp("知识库 ID（读 Wiki 页面时与 pageKey 一起传）"),
			"pageKey":         optStrProp("Wiki 页面 Key", 200),
		}, "required": []string{}}},
	{name: "ask_documents", title: "文档问答",
		description: "基于文档上下文的一次性问答：服务端自动检索相关文档并调用模型生成答案，返回答案与引用。会产生模型调用费用。",
		scope:       "qa:read", endpoint: "/api/agent/document/qa",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"question":        optStrProp("要提问的问题", 1000),
			"knowledgeBaseId": idSchemaProp("可选：限定单个知识库"),
			"limit":           intProp("检索上下文条数上限，默认 6", 1, 10),
		}, "required": []string{"question"}}},
	{name: "list_articles", title: "列出文章",
		description: "按条件列出指定知识库内的文章（支持标题关键词、标签、父文件夹过滤），返回文章 ID、标题、标签与路径。",
		scope:       "doc:read", endpoint: "/api/agent/article/list",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"knowledgeBaseId": idSchemaProp("知识库 ID"),
			"keyword":         optStrProp("标题关键词过滤", 200),
			"tags":            tagsProp(),
			"parentId":        idSchemaProp("父文件夹节点 ID，不传表示不过滤"),
			"limit":           intProp("返回条数上限，默认 50", 1, 200),
		}, "required": []string{"knowledgeBaseId"}}},
	{name: "create_folder", title: "新建文件夹",
		description: "在指定知识库中新建文件夹，可通过 parentId 指定父文件夹（不传则在根目录创建）。",
		scope:       "article:write", endpoint: "/api/agent/folder/create",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"knowledgeBaseId": idSchemaProp("知识库 ID"),
			"name":            optStrProp("文件夹名称", 200),
			"parentId":        idSchemaProp("可选：父文件夹节点 ID"),
		}, "required": []string{"knowledgeBaseId", "name"}}},
	{name: "create_article", title: "新建文章",
		description: "在指定知识库中新建 Markdown 文章，可指定父文件夹与标签，返回新文章的 articleId。",
		scope:       "article:write", endpoint: "/api/agent/article/create",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"knowledgeBaseId": idSchemaProp("知识库 ID"),
			"title":           optStrProp("文章标题", 200),
			"contentMd":       map[string]any{"type": "string", "minLength": 1, "description": "Markdown 正文"},
			"parentId":        idSchemaProp("可选：父文件夹节点 ID"),
			"tags":            tagsProp(),
		}, "required": []string{"knowledgeBaseId", "title", "contentMd"}}},
	{name: "update_article", title: "更新文章",
		description: "更新文章的标题、正文与标签。注意 contentMd 是全量覆盖：请先用 view_document 读取原文，在其基础上修改后整体提交，避免丢内容。",
		scope:       "article:write", endpoint: "/api/agent/article/update",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"articleId": idSchemaProp("文章 ID"),
			"title":     optStrProp("文章标题", 200),
			"contentMd": map[string]any{"type": "string", "minLength": 1, "description": "Markdown 正文（全量覆盖）"},
			"tags":      tagsProp(),
		}, "required": []string{"articleId", "title", "contentMd"}}},
	{name: "delete_article", title: "删除文章",
		description: "删除指定文章（不可恢复）。删除前必须向用户复述文章 ID 与标题，并获得明确确认。",
		scope:       "article:delete", endpoint: "/api/agent/article/delete",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"articleId": idSchemaProp("文章 ID"),
		}, "required": []string{"articleId"}}},
	{name: "move_article", title: "移动文章",
		description: "把文章移动到目标文件夹（parentId 不传表示移到根目录），可用 targetIndex 指定排序位置。",
		scope:       "article:write", endpoint: "/api/agent/article/move",
		inputSchema: map[string]any{"type": "object", "properties": map[string]any{
			"articleId":   idSchemaProp("文章 ID"),
			"parentId":    idSchemaProp("目标父文件夹节点 ID，不传表示根目录"),
			"targetIndex": intProp("可选：目标位置（从 0 开始）", 0, 1000000),
		}, "required": []string{"articleId"}}},
}

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  struct {
		ProtocolVersion string          `json:"protocolVersion"`
		Name            string          `json:"name"`
		Arguments       json.RawMessage `json:"arguments"`
	} `json:"params"`
}

// McpPOST POST /api/mcp：鉴权走 auth.RequireAgentKey("") 中间件。
func McpPOST(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil || len(body) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"jsonrpc": "2.0", "error": gin.H{"code": -32700, "message": "请求体必须是合法 JSON"}, "id": nil})
		return
	}
	var req mcpRequest
	if err := json.Unmarshal(body, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"jsonrpc": "2.0", "error": gin.H{"code": -32700, "message": "Parse error"}, "id": nil})
		return
	}
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"

	switch req.Method {
	case "initialize":
		result := gin.H{
			"protocolVersion": firstNonEmptyStr(req.Params.ProtocolVersion, "2025-06-18"),
			"capabilities":    gin.H{"tools": gin.H{}},
			"serverInfo": gin.H{
				"name":    mcpServerName,
				"version": mcpServerVersion,
			},
			"instructions": mcpServerInstructions,
		}
		writeMCPResult(c, req.ID, result)
	case "notifications/initialized":
		c.Status(http.StatusAccepted)
	case "tools/list":
		tools := make([]gin.H, 0, len(mcpToolSpecs))
		for _, spec := range mcpToolSpecs {
			tools = append(tools, gin.H{
				"name":        spec.name,
				"title":       spec.title,
				"description": spec.description,
				"inputSchema": spec.inputSchema,
			})
		}
		writeMCPResult(c, req.ID, gin.H{"tools": tools})
	case "tools/call":
		actx := auth.AgentAuth(c)
		if actx == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"jsonrpc": "2.0", "error": gin.H{"code": -32001, "message": "缺少 Agent API Key"}, "id": req.ID})
			return
		}
		result := callMCPTool(c, actx, req.Params.Name, req.Params.Arguments)
		writeMCPResult(c, req.ID, result)
	default:
		if isNotification {
			c.Status(http.StatusAccepted)
			return
		}
		c.JSON(http.StatusOK, gin.H{"jsonrpc": "2.0", "error": gin.H{"code": -32601, "message": "Method not found: " + req.Method}, "id": req.ID})
	}
}

func writeMCPResult(c *gin.Context, id json.RawMessage, result any) {
	idOut := json.RawMessage("null")
	if len(id) > 0 {
		idOut = id
	}
	c.JSON(http.StatusOK, gin.H{"jsonrpc": "2.0", "result": result, "id": idOut})
}

// McpDELETE DELETE /api/mcp：无状态实现直接 204。
func McpDELETE(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func missingTokenResultText() string {
	return "缺少 API Key：请在 MCP 客户端为该服务器配置请求头 Authorization: Bearer <ptc_live_...>（API Key 在 Petrichor 账号设置中生成）。"
}

// callMCPTool 对照 delegateAgentMcpToolCall + toAgentMcpToolResult：
// 委托到对应 REST 端点语义的核心函数，并把结果包装成 MCP 工具结果。
func callMCPTool(c *gin.Context, actx *auth.AgentAuthContext, toolName string, argsRaw json.RawMessage) gin.H {
	spec := findMCPToolSpec(toolName)
	if spec == nil {
		return gin.H{
			"isError": true,
			"content": []gin.H{{"type": "text", "text": "未知工具：" + toolName}},
		}
	}
	args := map[string]any{}
	if len(argsRaw) > 0 {
		_ = json.Unmarshal(argsRaw, &args)
	}

	startedAt := time.Now()
	statusCode, bodyBytes, execErr := executeMCPDelegate(c, actx, spec, args)
	durationMs := time.Since(startedAt).Milliseconds()

	ip := resolveClientIp(c)
	userAgent := c.GetHeader("User-Agent")
	recordAgentCallLogRow(actx, "POST", spec.endpoint, ip, userAgentPtr(userAgent),
		string(argsRaw), string(bodyBytes), statusCode, durationMs, execErr)

	if statusCode >= 200 && statusCode < 300 {
		text := strings.TrimSpace(string(bodyBytes))
		if text == "" {
			text = "{}"
		}
		return gin.H{"content": []gin.H{{"type": "text", "text": text}}}
	}
	msg := extractAgentErrorMessageFromBody(bodyBytes)
	if msg == "" {
		msg = clipJSONBody(bodyBytes)
	}
	return gin.H{
		"isError": true,
		"content": []gin.H{{"type": "text", "text": "请求失败（HTTP " + strconv.Itoa(statusCode) + "）：" + msg}},
	}
}

func findMCPToolSpec(name string) *mcpToolSpec {
	for i := range mcpToolSpecs {
		if mcpToolSpecs[i].name == name {
			return &mcpToolSpecs[i]
		}
	}
	return nil
}

func userAgentPtr(ua string) *string {
	if ua == "" {
		return nil
	}
	return &ua
}

func extractAgentErrorMessageFromBody(body []byte) string {
	var parsed struct {
		Msg string `json:"msg"`
	}
	if json.Unmarshal(body, &parsed) == nil && strings.TrimSpace(parsed.Msg) != "" {
		return strings.TrimSpace(parsed.Msg)
	}
	return ""
}

func clipJSONBody(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "未知错误"
	}
	runes := []rune(text)
	if len(runes) <= 2000 {
		return text
	}
	return string(runes[:2000]) + "…"
}

// executeMCPDelegate 以工具对应的 REST 端点语义执行核心函数：
// scope 校验文案与状态码与 REST 完全一致（403「当前 API Key 缺少 xxx 权限」）。
func executeMCPDelegate(
	parent *gin.Context,
	actx *auth.AgentAuthContext,
	spec *mcpToolSpec,
	args map[string]any,
) (int, []byte, error) {
	proxyCtx := cloneGinContext(parent, args)
	data, handlerErr := dispatchAgentCore(proxyCtx, actx, spec.scope, spec.endpoint)
	if handlerErr != nil {
		if he, ok := handlerErr.(*httpx.HttpError); ok {
			return he.Status, mustJSON(gin.H{
				"code": he.Status, "msg": he.Message,
				"path": spec.endpoint, "timestamp": httpx.FormatISO(time.Now()),
			}), handlerErr
		}
		return 500, mustJSON(gin.H{
			"code": 500, "msg": "系统异常，请稍后重试",
			"path": spec.endpoint, "timestamp": httpx.FormatISO(time.Now()),
		}), handlerErr
	}
	return 200, mustJSON(data), nil
}

func mustJSON(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return raw
}

// dispatchAgentCore 把 REST 端点路径映射到对应核心函数（MCP 工具委托与路由共用）。
func dispatchAgentCore(c *gin.Context, actx *auth.AgentAuthContext, scope, endpoint string) (any, error) {
	if err := requireAgentScope(actx, scope); err != nil {
		return nil, err
	}
	switch endpoint {
	case "/api/agent/knowledge-base/list":
		return AgentListKnowledgeBases(c, actx)
	case "/api/agent/knowledge-base/tree":
		return AgentKnowledgeBaseTree(c, actx)
	case "/api/agent/folder/create":
		return AgentCreateFolder(c, actx)
	case "/api/agent/article/create":
		return AgentCreateArticle(c, actx)
	case "/api/agent/article/update":
		return AgentUpdateArticle(c, actx)
	case "/api/agent/article/delete":
		return AgentDeleteArticle(c, actx)
	case "/api/agent/article/list":
		return AgentListArticles(c, actx)
	case "/api/agent/article/move":
		return AgentMoveArticle(c, actx)
	case "/api/agent/document/search":
		return AgentSearchDocuments(c, actx)
	case "/api/agent/document/tree":
		return AgentRetrieveDocumentTree(c, actx)
	case "/api/agent/document/semantic-search":
		return AgentSemanticSearchDocumentTree(c, actx)
	case "/api/agent/document/view":
		return AgentViewDocument(c, actx)
	case "/api/agent/document/qa":
		return AgentAskDocument(c, actx)
	default:
		return nil, httpx.NotFound("接口不存在")
	}
}

// cloneGinContext 构造一个以 args JSON 为请求体的轻量上下文，供 MCP 工具委托复用
// REST 端点的参数解析逻辑（不落任何响应，响应由调用方捕获返回值）。
func cloneGinContext(parent *gin.Context, args map[string]any) *gin.Context {
	raw := mustJSON(args)
	req := parent.Request.Clone(parent.Request.Context())
	if req == nil {
		req, _ = http.NewRequest(http.MethodPost, "/api/mcp", bytes.NewReader(raw))
	} else {
		req.Body = io.NopCloser(bytes.NewReader(raw))
		req.ContentLength = int64(len(raw))
		req.Header = parent.Request.Header.Clone()
	}
	// CreateTestContext 提供丢弃型 ResponseWriter（结果通过返回值传递，不落响应）。
	proxyCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	proxyCtx.Request = req
	return proxyCtx
}
