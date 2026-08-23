package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/agentapi"
	"petrichor/api/internal/auth"
)

// registerAgentRoutes Agent 开放接口组（对照 app/api/agent/**/route.ts 与 app/api/mcp/route.ts）。
//
// 鉴权分层：
//   - manifest / skill / skill-pack 公开（照 TS 语义，manifest 供无 Key 的 CLI 自检）；
//   - api-key create/list/revoke 与 call-log/list 走 RequireUser 用户态；
//   - 其余端点统一 RequireAgentKey("") 鉴权（无效 Key 401 不记调用日志），
//     各端点内部再校验对应 scope（403 会进入调用日志），与 TS withAgent 语义一致。
func registerAgentRoutes(rg *gin.RouterGroup) {
	// ===== 公开发现类 =====
	rg.GET("/agent/manifest", agentapi.ManifestHandler())
	rg.GET("/agent/skill", agentapi.SkillHandler())
	rg.GET("/agent/skill-pack", agentapi.SkillPackHandler())

	// ===== 用户态：API Key 管理 + 调用日志 =====
	user := rg.Group("/agent", auth.RequireUser())
	user.POST("/api-key/create", agentapi.UserEndpoint(agentapi.CreateAPIKey))
	user.POST("/api-key/list", agentapi.UserEndpoint(agentapi.ListAPIKeys))
	user.POST("/api-key/revoke", agentapi.UserEndpoint(agentapi.RevokeAPIKey))
	user.POST("/call-log/list", agentapi.UserEndpoint(agentapi.ListCallLogs))

	// ===== Agent Key 态 =====
	agent := rg.Group("/agent", auth.RequireAgentKey(""))
	agent.GET("/capabilities", agentapi.AgentEndpoint(agentapi.AgentCapabilities))
	agent.POST("/knowledge-base/list", agentapi.AgentEndpoint(agentapi.AgentListKnowledgeBases))
	agent.POST("/knowledge-base/tree", agentapi.AgentEndpoint(agentapi.AgentKnowledgeBaseTree))
	agent.POST("/folder/create", agentapi.AgentEndpoint(agentapi.AgentCreateFolder))
	agent.POST("/article/create", agentapi.AgentEndpoint(agentapi.AgentCreateArticle))
	agent.POST("/article/update", agentapi.AgentEndpoint(agentapi.AgentUpdateArticle))
	agent.POST("/article/delete", agentapi.AgentEndpoint(agentapi.AgentDeleteArticle))
	agent.POST("/article/list", agentapi.AgentEndpoint(agentapi.AgentListArticles))
	agent.POST("/article/move", agentapi.AgentEndpoint(agentapi.AgentMoveArticle))
	agent.POST("/article/share/create", agentapi.AgentEndpoint(agentapi.AgentShareCreate))
	agent.POST("/article/share/info", agentapi.AgentEndpoint(agentapi.AgentShareInfo))
	agent.POST("/article/share/revoke", agentapi.AgentEndpoint(agentapi.AgentShareRevoke))
	agent.POST("/article/summary/generate", agentapi.AgentEndpoint(agentapi.AgentGenerateArticleSummary))
	agent.POST("/article/mindmap/generate", agentapi.AgentEndpoint(agentapi.AgentGenerateArticleMindmap))
	agent.POST("/document/search", agentapi.AgentEndpoint(agentapi.AgentSearchDocuments))
	agent.POST("/document/tree", agentapi.AgentEndpoint(agentapi.AgentRetrieveDocumentTree))
	agent.POST("/document/semantic-search", agentapi.AgentEndpoint(agentapi.AgentSemanticSearchDocumentTree))
	agent.POST("/document/view", agentapi.AgentEndpoint(agentapi.AgentViewDocument))
	agent.POST("/document/qa", agentapi.AgentEndpoint(agentapi.AgentAskDocument))
	agent.POST("/wiki/page/list", agentapi.AgentEndpoint(agentapi.AgentWikiPageList))
	agent.POST("/wiki/page/detail", agentapi.AgentEndpoint(agentapi.AgentWikiPageDetail))
	agent.POST("/wiki/lint", agentapi.AgentEndpoint(agentapi.AgentWikiLint))
	agent.POST("/wiki/ingest", agentapi.AgentEndpoint(agentapi.AgentWikiIngest))

	// ===== MCP（Streamable HTTP 最小实现，Bearer Agent Key）=====
	mcpGroup := rg.Group("/mcp", auth.RequireAgentKey(""))
	mcpGroup.POST("", agentapi.McpPOST)
	mcpGroup.DELETE("", agentapi.McpDELETE)
}
