package main

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/config"
	_ "petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/routes"
)

func main() {
	cfg := config.Get()
	aicore.WireInvokers()
	if !config.IsProduction() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	r.MaxMultipartMemory = 64 << 20

	// 与 Next.js 版本一致：同源部署，无需 CORS。
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	api := r.Group("/api")
	routes.RegisterPublic(api)
	routes.RegisterAuth(api)
	routes.RegisterNotification(api)
	routes.RegisterDashboard(api)
	routes.RegisterKB(api)
	routes.RegisterDocLibrary(api)
	routes.RegisterAdmin(api)
	routes.RegisterUpload(api)
	routes.RegisterAI(api)
	routes.RegisterAssistant(api)
	routes.RegisterAgent(api)

	// 兜底：未匹配的 /api 路径按 404 契约返回
	r.NoRoute(func(c *gin.Context) {
		if len(c.Request.URL.Path) >= 5 && c.Request.URL.Path[:5] == "/api/" {
			httpx.ErrorJSON(c, http.StatusNotFound, "接口不存在")
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	})

	addr := ":" + cfg.APIPort
	log.Printf("Petrichor Go API listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}
