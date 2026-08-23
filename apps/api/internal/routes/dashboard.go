package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/dashboardpkg"
	httpx "petrichor/api/internal/httpx"
)

// registerDashboardRoutes 控制台总览：需登录。
func registerDashboardRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/dashboard", auth.RequireUser())
	g.POST("/overview", func(c *gin.Context) {
		user := auth.CurrentUser(c)
		overview, err := dashboardpkg.LoadDashboardOverview(c.Request.Context(), user.ID)
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		httpx.OK(c, overview)
	})
}
