// Command worker 运行 PostgreSQL 持久化视觉导入任务，不承载 HTTP 请求。
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/bootstrap"
	"petrichor/api/internal/cache"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/kb"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if _, err := config.Initialize(); err != nil {
		return err
	}

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelStartup()
	if err := db.Initialize(startupCtx); err != nil {
		return fmt.Errorf("初始化数据库连接池失败: %w", err)
	}
	defer db.Close()
	if err := cache.Initialize(startupCtx); err != nil {
		return fmt.Errorf("初始化 Redis 缓存失败: %w", err)
	}
	defer cache.Close()

	aicore.WireInvokers()
	bootstrap.WireLLM()

	workerCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	waitImportWorkers := kb.StartImportJobWorkers(workerCtx)
	log.Print("Petrichor 视觉导入 Worker 已启动")

	<-workerCtx.Done()
	log.Print("收到关停信号，正在停止视觉导入任务")
	waitImportWorkers()
	log.Print("Petrichor 视觉导入 Worker 已安全关闭")
	return nil
}
