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

	g.GET("/projects", adminpanel.AdminProjectShowcaseDetail)
	g.POST("/projects", adminpanel.AdminProjectShowcaseUpdate)

	sg := g.Group("/site-graph")
	sg.GET("/overview", adminpanel.AdminSiteGraphOverview)
	sg.POST("/overview", adminpanel.AdminSiteGraphOverview)
	sg.POST("/generate", adminpanel.AdminSiteGraphGenerate)
	sg.POST("/validate", adminpanel.AdminSiteGraphValidate)
	sg.POST("/publish", adminpanel.AdminSiteGraphPublish)
	sg.POST("/unpublish", adminpanel.AdminSiteGraphUnpublish)
	sg.POST("/clear", adminpanel.AdminSiteGraphClear)
	sg.POST("/node/save", adminpanel.AdminSiteGraphNodeSave)
	sg.POST("/node/delete", adminpanel.AdminSiteGraphNodeDelete)
	sg.POST("/edge/save", adminpanel.AdminSiteGraphEdgeSave)
	sg.POST("/edge/delete", adminpanel.AdminSiteGraphEdgeDelete)
	sg.POST("/subtree", adminpanel.AdminSiteGraphSubtree)
	sg.POST("/neighborhood", adminpanel.AdminSiteGraphNeighborhood)
	sg.POST("/merge/confirm", adminpanel.AdminSiteGraphMergeConfirm)
	sg.POST("/merge/ignore", adminpanel.AdminSiteGraphMergeIgnore)

	ug := g.Group("/user")
	ug.POST("/list", adminpanel.UserList)
	ug.POST("/create", adminpanel.UserCreate)
	ug.POST("/delete", adminpanel.UserDelete)
}
