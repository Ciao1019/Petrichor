package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/bootstrap"
	"petrichor/api/internal/cache"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/dbmigrate"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/routes"
	"petrichor/api/internal/taskqueue"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := config.Initialize()
	if err != nil {
		return err
	}

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelStartup()
	if err := migrateDatabase(startupCtx, cfg); err != nil {
		return fmt.Errorf("数据库自动迁移失败，Go API 未启动: %w", err)
	}
	if err := db.Initialize(startupCtx); err != nil {
		return fmt.Errorf("初始化数据库连接池失败: %w", err)
	}
	defer db.Close()
	if err := cache.Initialize(startupCtx); err != nil {
		return fmt.Errorf("初始化 Redis 缓存失败: %w", err)
	}
	defer cache.Close()
	if err := taskqueue.Initialize(startupCtx); err != nil {
		return fmt.Errorf("初始化 Asynq 任务队列失败: %w", err)
	}
	defer taskqueue.Close()
	if err := auth.InitializeSaToken(); err != nil {
		return err
	}
	aicore.WireInvokers()
	bootstrap.WireLLM()

	if !config.IsProduction() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.New()
	if err := r.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		return fmt.Errorf("配置可信代理失败: %w", err)
	}
	r.Use(
		httpx.RequestID(),
		httpx.SecurityHeaders(),
		httpx.RequestBodyLimit(cfg.RequestLimits.JSONBodyBytes, cfg.RequestLimits.UploadBytes),
		httpx.AccessLogger(),
		httpx.ErrorLogger(),
		gin.Recovery(),
	)
	r.Use(auth.SaTokenInterceptor())
	r.MaxMultipartMemory = 64 << 20

	// liveness 只证明进程可响应；readiness 同时验证 PostgreSQL、缓存与 Asynq Redis。
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	r.GET("/readyz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			httpx.ErrorJSON(c, http.StatusServiceUnavailable, "服务尚未就绪")
			return
		}
		if err := cache.Ping(ctx); err != nil {
			httpx.ErrorJSON(c, http.StatusServiceUnavailable, "服务尚未就绪")
			return
		}
		if err := taskqueue.Ping(ctx); err != nil {
			httpx.ErrorJSON(c, http.StatusServiceUnavailable, "服务尚未就绪")
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
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

	// 兜底：未匹配的 /api 路径按 404 契约返回。
	r.NoRoute(func(c *gin.Context) {
		if len(c.Request.URL.Path) >= 5 && c.Request.URL.Path[:5] == "/api/" {
			httpx.ErrorJSON(c, http.StatusNotFound, "接口不存在")
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	})

	addr := cfg.Host + ":" + cfg.APIPort
	server := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: cfg.HTTPServer.ReadHeaderTimeout,
		ReadTimeout:       cfg.HTTPServer.ReadTimeout,
		WriteTimeout:      cfg.HTTPServer.WriteTimeout,
		IdleTimeout:       cfg.HTTPServer.IdleTimeout,
	}

	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	serveErr := make(chan error, 1)
	go func() {
		log.Printf("Petrichor Go API listening on %s", addr)
		serveErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("Go API 监听失败: %w", err)
	case <-signalCtx.Done():
		log.Print("收到关停信号，正在停止接收新请求")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.HTTPServer.ShutdownTimeout)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
		return fmt.Errorf("Go API 优雅关闭超时: %w", err)
	}
	if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("Go API 关闭时监听异常: %w", err)
	}
	log.Print("Petrichor Go API 已安全关闭")
	return nil
}

func migrateDatabase(ctx context.Context, cfg *config.Config) error {
	log.Print("正在检查数据库迁移")
	results, err := dbmigrate.Up(ctx, cfg)
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
