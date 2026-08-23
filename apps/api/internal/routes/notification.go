package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/notification"
)

// registerNotificationRoutes 通知组：summary 为 GET，list/read/read-all 为 POST；全部需登录。
func registerNotificationRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/notification", auth.RequireUser())
	g.GET("/summary", notification.Summary)
	g.POST("/list", notification.List)
	g.POST("/read", notification.Read)
	g.POST("/read-all", notification.ReadAll)
}
