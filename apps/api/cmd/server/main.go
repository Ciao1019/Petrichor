package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/db"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/router"
	"github.com/Ciao1019/Petrichor/apps/api/internal/logger"
)

func main() {
	// 逐个加载：某一文件不存在时不能中断后续（godotenv.Load 多文件会在首个失败处返回）。
	for _, name := range []string{".env", ".env.local"} {
		_ = godotenv.Load(name)
	}

	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}

	log, err := logger.New(cfg.IsProduction())
	if err != nil {
		panic(err)
	}
	defer func() { _ = log.Sync() }()

	conn, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatal("数据库初始化失败", zap.Error(err))
	}
	defer func() { _ = conn.Close() }()

	appCtx, cancelApp := context.WithCancel(context.Background())
	defer cancelApp()
	engine := router.New(router.Dependencies{
		Context: appCtx,
		Config:  cfg,
		Client:  conn.Ent,
		SQL:     conn.SQL,
		Log:     log,
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           engine,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("Petrichor Go API 启动", zap.String("addr", cfg.HTTPAddr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("HTTP 服务异常退出", zap.Error(err))
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	cancelApp()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("优雅关闭失败", zap.Error(err))
	}
	log.Info("Petrichor Go API 已停止")
}
