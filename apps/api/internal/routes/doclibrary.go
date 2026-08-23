package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/doclibrary"
)

// registerDocLibraryRoutes 文档库域：所有端点先过登录中间件，再以 user.ID 做租户过滤。
func registerDocLibraryRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/doc-library", auth.RequireUser())
	g.GET("/library/list", doclibrary.ListLibrariesHandler)
	g.POST("/library/save", doclibrary.SaveLibraryHandler)
	g.POST("/library/delete", doclibrary.DeleteLibraryHandler)
	g.POST("/folder/save", doclibrary.SaveFolderHandler)
	g.POST("/folder/list", doclibrary.ListFoldersHandler)
	g.POST("/folder/delete", doclibrary.DeleteFolderHandler)
	g.POST("/document/list", doclibrary.ListDocumentsHandler)
	g.POST("/document/detail", doclibrary.DocumentDetailHandler)
	g.POST("/document/delete", doclibrary.DeleteDocumentHandler)
	g.POST("/document/register", doclibrary.RegisterDocumentHandler)
}
