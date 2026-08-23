package routes

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/uploadsvc"
)

// registerUploadRoutes 上传域：presign 需登录；本地对象 PUT 需登录、GET 公开。
func registerUploadRoutes(rg *gin.RouterGroup) {
	g := rg.Group("/upload")
	g.POST("/presign-put", auth.RequireUser(), uploadsvc.PresignPutObject)
	g.POST("/presign-get", auth.RequireUser(), uploadsvc.PresignGetObject)

	local := g.Group("/local")
	local.PUT("/*objectKey", auth.RequireUser(), uploadsvc.UploadLocalObject)
	local.GET("/*objectKey", uploadsvc.ServeLocalObject)
}
