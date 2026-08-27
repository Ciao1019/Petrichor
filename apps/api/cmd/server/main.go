package main

import (
	"context"
	"log"
	"net/http"
	"path/filepath"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/bootstrap"
	"petrichor/api/internal/config"
	_ "petrichor/api/internal/db"
	"petrichor/api/internal/dbmigrate"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/routes"
)

func main() {
	cfg, err := config.Initialize()
	if err != nil {
		log.Fatal(err)
	}
	if err := migrateDatabase(cfg); err != nil {
		log.Fatal("数据库自动迁移失败，Go API 未启动: ", err)
	}
	aicore.WireInvokers()
	bootstrap.WireLLM()
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

	addr := cfg.Host + ":" + cfg.APIPort
	log.Printf("Petrichor Go API listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}

func migrateDatabase(cfg *config.Config) error {
	log.Print("正在检查数据库迁移")
	results, err := dbmigrate.Up(context.Background(), cfg)
	if err != nil {
		return err
	}
	if len(results) == 0 {
		log.Print("数据库迁移已是最新版本")
		return nil
	}
	for _, result := range results {
		log.Printf("已执行数据库迁移 %s（%s）", filepath.Base(result.Source.Path), result.Duration)
	}
	log.Printf("数据库自动迁移完成，共执行 %d 个迁移", len(results))
	return nil
}
