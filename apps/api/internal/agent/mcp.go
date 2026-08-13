package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/gin-gonic/gin"
)

type agentMCPToolSpec struct {
	Name        string
	Title       string
	Description string
	Scope       string
	Properties  gin.H
	Required    []string
}

func stringProperty(description string) gin.H {
	return gin.H{"type": []string{"string", "number"}, "description": description}
}

func integerProperty(description string, minimum, maximum int) gin.H {
	property := gin.H{"type": "integer", "description": description, "minimum": minimum}
	if maximum > 0 {
		property["maximum"] = maximum
	}
	return property
}

var agentMCPTools = []agentMCPToolSpec{
	{Name: "list_knowledge_bases", Title: "列出知识库", Description: "列出当前 API Key 所属用户的全部知识库。", Scope: "doc:read", Properties: gin.H{}},
	{Name: "get_knowledge_base_tree", Title: "查看知识库目录树", Description: "查看指定知识库的完整目录树。", Scope: "doc:read", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID")}, Required: []string{"knowledgeBaseId"}},
	{Name: "search_documents", Title: "搜索知识库", Description: "混合检索文件分片、Wiki 页面与知识文章。", Scope: "doc:read", Properties: gin.H{"query": gin.H{"type": "string", "minLength": 1, "maxLength": 200}, "knowledgeBaseId": stringProperty("可选知识库 ID"), "limit": integerProperty("返回条数", 1, 20)}, Required: []string{"query"}},
	{Name: "view_document", Title: "读取文档全文", Description: "读取源文章，或以 knowledgeBaseId 与 pageKey 读取 Wiki 页面。", Scope: "doc:read", Properties: gin.H{"articleId": stringProperty("文章 ID"), "knowledgeBaseId": stringProperty("知识库 ID"), "pageKey": gin.H{"type": "string", "maxLength": 200}}},
	{Name: "ask_documents", Title: "文档问答", Description: "检索相关文档并调用模型生成带引用的答案。", Scope: "qa:read", Properties: gin.H{"question": gin.H{"type": "string", "minLength": 1, "maxLength": 1000}, "knowledgeBaseId": stringProperty("可选知识库 ID"), "limit": integerProperty("上下文条数", 1, 10)}, Required: []string{"question"}},
	{Name: "list_articles", Title: "列出文章", Description: "按条件列出知识库内的文章。", Scope: "doc:read", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID"), "keyword": gin.H{"type": "string", "maxLength": 200}, "tags": gin.H{"type": "array", "items": gin.H{"type": "string"}, "maxItems": 50}, "parentId": stringProperty("父文件夹 ID"), "limit": integerProperty("返回条数", 1, 200)}, Required: []string{"knowledgeBaseId"}},
	{Name: "create_folder", Title: "新建文件夹", Description: "在指定知识库中新建文件夹。", Scope: "article:write", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID"), "name": gin.H{"type": "string", "minLength": 1, "maxLength": 200}, "parentId": stringProperty("可选父文件夹 ID")}, Required: []string{"knowledgeBaseId", "name"}},
	{Name: "create_article", Title: "新建文章", Description: "在指定知识库中新建 Markdown 文章。", Scope: "article:write", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID"), "title": gin.H{"type": "string", "minLength": 1, "maxLength": 200}, "contentMd": gin.H{"type": "string", "minLength": 1}, "parentId": stringProperty("可选父文件夹 ID"), "tags": gin.H{"type": "array", "items": gin.H{"type": "string"}, "maxItems": 50}}, Required: []string{"knowledgeBaseId", "title", "contentMd"}},
	{Name: "update_article", Title: "更新文章", Description: "全量更新文章标题、正文与标签。", Scope: "article:write", Properties: gin.H{"articleId": stringProperty("文章 ID"), "title": gin.H{"type": "string", "minLength": 1, "maxLength": 200}, "contentMd": gin.H{"type": "string", "minLength": 1}, "tags": gin.H{"type": "array", "items": gin.H{"type": "string"}, "maxItems": 50}}, Required: []string{"articleId", "title", "contentMd"}},
	{Name: "delete_article", Title: "删除文章", Description: "删除指定文章；操作不可恢复。", Scope: "article:delete", Properties: gin.H{"articleId": stringProperty("文章 ID")}, Required: []string{"articleId"}},
	{Name: "move_article", Title: "移动文章", Description: "移动文章到目标文件夹并可调整顺序。", Scope: "article:write", Properties: gin.H{"articleId": stringProperty("文章 ID"), "parentId": stringProperty("目标父文件夹 ID"), "targetIndex": integerProperty("目标位置", 0, 0)}, Required: []string{"articleId"}},
	{Name: "list_wiki_pages", Title: "列出 Wiki 页面", Description: "列出指定知识库的 Wiki 页面。", Scope: "wiki:read", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID")}, Required: []string{"knowledgeBaseId"}},
	{Name: "read_wiki_page", Title: "读取 Wiki 页面", Description: "读取 Wiki 页面正文、文件分片来源与出链。", Scope: "wiki:read", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID"), "pageKey": gin.H{"type": "string", "minLength": 1, "maxLength": 200}}, Required: []string{"knowledgeBaseId", "pageKey"}},
	{Name: "wiki_lint", Title: "Wiki 体检", Description: "检查文件来源、断链和孤立页面。", Scope: "wiki:read", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID")}, Required: []string{"knowledgeBaseId"}},
	{Name: "wiki_ingest", Title: "重建 Wiki", Description: "从知识库文件及其分片增量或全量重建 Wiki。", Scope: "wiki:write", Properties: gin.H{"knowledgeBaseId": stringProperty("知识库 ID"), "documentIds": gin.H{"type": "array", "items": stringProperty("文件 ID"), "maxItems": 500}, "forceRebuild": gin.H{"type": "boolean"}}, Required: []string{"knowledgeBaseId"}},
	{Name: "share_article", Title: "创建或更新文章分享", Description: "创建或更新文章公开分享。", Scope: "share:write", Properties: gin.H{"articleId": stringProperty("文章 ID"), "passwordEnabled": gin.H{"type": "boolean"}, "accessPassword": gin.H{"type": "string", "pattern": "^[0-9]{6}$"}, "expiresAt": gin.H{"type": "string"}}, Required: []string{"articleId"}},
	{Name: "get_article_share", Title: "查询文章分享状态", Description: "查询文章当前分享状态。", Scope: "share:write", Properties: gin.H{"articleId": stringProperty("文章 ID")}, Required: []string{"articleId"}},
	{Name: "revoke_article_share", Title: "撤销文章分享", Description: "撤销文章的公开分享链接。", Scope: "share:write", Properties: gin.H{"articleId": stringProperty("文章 ID")}, Required: []string{"articleId"}},
}

// MCP 实现无会话状态，覆盖 initialize、tools/list、tools/call 与 ping。
func (h *Handler) MCP(c *gin.Context) {
	if c.Request.Method == http.MethodDelete {
		c.Status(http.StatusOK)
		return
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		writeMCPError(c, nil, -32700, "Parse error")
		return
	}
	var rpc struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      any             `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &rpc); err != nil || rpc.JSONRPC != "2.0" {
		writeMCPError(c, nil, -32700, "Parse error")
		return
	}

	switch rpc.Method {
	case "initialize":
		protocolVersion := "2024-11-05"
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if json.Unmarshal(rpc.Params, &params) == nil && strings.TrimSpace(params.ProtocolVersion) != "" {
			protocolVersion = params.ProtocolVersion
		}
		writeMCPResult(c, rpc.ID, gin.H{
			"protocolVersion": protocolVersion,
			"capabilities":    gin.H{"tools": gin.H{"listChanged": false}},
			"serverInfo":      gin.H{"name": "petrichor", "version": "2026-07-02"},
			"instructions":    "Petrichor 个人知识库 MCP Server。写入前先读取原文；删除文章与撤销分享前必须获得用户确认。",
		})
	case "tools/list":
		tools := make([]gin.H, 0, len(agentMCPTools))
		for _, spec := range agentMCPTools {
			schema := gin.H{"type": "object", "properties": spec.Properties, "additionalProperties": false}
			if len(spec.Required) > 0 {
				schema["required"] = spec.Required
			}
			tools = append(tools, gin.H{
				"name": spec.Name, "title": spec.Title, "description": spec.Description, "inputSchema": schema,
			})
		}
		writeMCPResult(c, rpc.ID, gin.H{"tools": tools})
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(rpc.Params, &params); err != nil || strings.TrimSpace(params.Name) == "" {
			writeMCPError(c, rpc.ID, -32602, "Invalid params")
			return
		}
		spec, ok := findAgentMCPTool(params.Name)
		if !ok {
			writeMCPError(c, rpc.ID, -32601, "Unknown tool: "+params.Name)
			return
		}
		if !agentHasScope(c, spec.Scope) {
			writeMCPResult(c, rpc.ID, mcpToolError(http.StatusForbidden, "当前 API Key 缺少 "+spec.Scope+" 权限"))
			return
		}
		result := h.callAgentMCPTool(c, spec.Name, params.Arguments)
		writeMCPResult(c, rpc.ID, result)
	case "ping":
		writeMCPResult(c, rpc.ID, gin.H{})
	case "notifications/initialized", "notifications/cancelled":
		c.Status(http.StatusAccepted)
	default:
		writeMCPError(c, rpc.ID, -32601, "Method not found: "+rpc.Method)
	}
}

func findAgentMCPTool(name string) (agentMCPToolSpec, bool) {
	for _, spec := range agentMCPTools {
		if spec.Name == name {
			return spec, true
		}
	}
	return agentMCPToolSpec{}, false
}

func (h *Handler) callAgentMCPTool(c *gin.Context, name string, arguments map[string]any) gin.H {
	body, _ := json.Marshal(arguments)
	recorder := httptest.NewRecorder()
	req, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, "/api/agent/mcp-tool", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	internal, _ := gin.CreateTestContext(recorder)
	internal.Request = req
	for _, key := range []string{ctxAgentKey, ctxAgentUser, ctxAgentScopes} {
		if value, ok := c.Get(key); ok {
			internal.Set(key, value)
		}
	}

	switch name {
	case "list_knowledge_bases":
		h.ListKnowledgeBases(internal)
	case "get_knowledge_base_tree":
		h.GetKnowledgeBaseTree(internal)
	case "search_documents":
		h.DocumentSearchREST(internal)
	case "view_document":
		h.ViewDocument(internal)
	case "ask_documents":
		h.AskDocumentREST(internal)
	case "list_articles":
		h.ListArticles(internal)
	case "create_folder":
		h.CreateFolderREST(internal)
	case "create_article":
		h.CreateArticleREST(internal)
	case "update_article":
		h.UpdateArticleREST(internal)
	case "delete_article":
		h.DeleteArticleREST(internal)
	case "move_article":
		h.MoveArticleREST(internal)
	case "list_wiki_pages":
		h.WikiPageListREST(internal)
	case "read_wiki_page":
		h.WikiPageDetailREST(internal)
	case "wiki_lint":
		h.WikiLintREST(internal)
	case "wiki_ingest":
		h.WikiIngestREST(internal)
	case "share_article":
		h.ShareCreateREST(internal)
	case "get_article_share":
		h.ShareInfoREST(internal)
	case "revoke_article_share":
		h.ShareRevokeREST(internal)
	}
	text := strings.TrimSpace(recorder.Body.String())
	if recorder.Code >= 200 && recorder.Code < 300 {
		if text == "" {
			text = "{}"
		}
		return gin.H{"content": []gin.H{{"type": "text", "text": text}}}
	}
	message := text
	var errorPayload struct {
		Message string `json:"msg"`
	}
	if json.Unmarshal([]byte(text), &errorPayload) == nil && strings.TrimSpace(errorPayload.Message) != "" {
		message = errorPayload.Message
	}
	if runes := []rune(message); len(runes) > 2000 {
		message = string(runes[:2000]) + "…"
	}
	return mcpToolError(recorder.Code, message)
}

func mcpToolError(status int, message string) gin.H {
	return gin.H{
		"isError": true,
		"content": []gin.H{{"type": "text", "text": fmt.Sprintf("请求失败（HTTP %d）：%s", status, message)}},
	}
}

func writeMCPResult(c *gin.Context, id any, result any) {
	c.JSON(http.StatusOK, gin.H{"jsonrpc": "2.0", "id": id, "result": result})
}

func writeMCPError(c *gin.Context, id any, code int, message string) {
	c.JSON(http.StatusOK, gin.H{
		"jsonrpc": "2.0", "id": id, "error": gin.H{"code": code, "message": message},
	})
}
