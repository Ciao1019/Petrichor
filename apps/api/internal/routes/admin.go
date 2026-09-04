package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/adminpanel"
	"petrichor/api/internal/auth"
)

// registerAdminRoutes 管理员域：全部端点挂 RequireUser + RequireSuperAdmin 链（对应 withAdmin）。
func registerAdminRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/admin", auth.RequireUser(), auth.RequireSuperAdmin())

	g.GET("/about/profile", adminpanel.AdminAboutProfileDetail)
	g.POST("/about/profile", adminpanel.AdminAboutProfileUpdate)

	g.GET("/appearance", adminpanel.AdminSiteAppearanceDetail)
	g.POST("/appearance", adminpanel.AdminSiteAppearanceUpdate)

	g.GET("/filing", adminpanel.AdminSiteFilingDetail)
	g.POST("/filing", adminpanel.AdminSiteFilingUpdate)

	g.GET("/projects", adminpanel.AdminProjectShowcaseDetail)
	g.POST("/projects", adminpanel.AdminProjectShowcaseUpdate)
	g.GET("/runtime/metrics", adminpanel.AdminRuntimeMetrics)
	g.GET("/runtime/dead-letters", adminpanel.AdminDeadLetterJobs)
	g.POST("/runtime/dead-letters/replay", adminpanel.AdminReplayDeadLetter)

	ug := g.Group("/user")
	ug.POST("/list", adminpanel.UserList)
	ug.POST("/create", adminpanel.UserCreate)
	ug.POST("/delete", adminpanel.UserDelete)
}
