package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/assistantsvc"
	"petrichor/api/internal/auth"
)

// registerAssistantRoutes 助手组：全部 POST + wiki/page GET，鉴权 RequireUser。
func registerAssistantRoutes(rg *gin.RouterGroup) {
	a := rg.Group("/assistant", auth.RequireUser())

	// 会话
	a.POST("/thread/create", assistantsvc.AssistantThreadCreateHandler)
	a.POST("/thread/detail", assistantsvc.AssistantThreadDetailHandler)
	a.POST("/thread/list", assistantsvc.AssistantThreadListHandler)
	a.POST("/thread/delete", assistantsvc.AssistantThreadDeleteHandler)
	a.POST("/thread/delete-many", assistantsvc.AssistantThreadDeleteManyHandler)

	// 计划
	a.POST("/plan/patch", assistantsvc.AssistantPlanPatchHandler)

	// 对话（UIMessage 流协议）
	a.POST("/chat", assistantsvc.AssistantChatHandler)

	// Agent Run 查询
	a.POST("/agent-run/list", assistantsvc.AgentRunListHandler)
	a.POST("/agent-run/detail", assistantsvc.AgentRunDetailHandler)
	a.POST("/agent-run/trace", assistantsvc.AgentRunTraceHandler)

	// Wiki 页面详情（GET）
	a.GET("/wiki/page", assistantsvc.AssistantWikiPageDetailHandler)
}
