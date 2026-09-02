// Command worker 运行 Asynq 知识构建与视觉导入任务，不承载 HTTP 请求。
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/hibiken/asynq"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/bootstrap"
	"petrichor/api/internal/cache"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/kb"
	"petrichor/api/internal/taskqueue"
)

const workerShutdownTimeout = 90 * time.Second

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

	aicore.WireInvokers()
	bootstrap.WireLLM()
	kb.ConfigureKnowledgeBuild(cfg.KnowledgeBuild)

	errorHandler := asynq.ErrorHandlerFunc(kb.HandleAsynqTaskError)
	knowledgeServer, err := taskqueue.NewServer(asynq.Config{
		Concurrency:     cfg.KnowledgeBuild.Concurrency,
		Queues:          map[string]int{taskqueue.QueueKnowledgeBuild: 1},
		RetryDelayFunc:  kb.AsynqRetryDelay,
		ErrorHandler:    errorHandler,
		ShutdownTimeout: workerShutdownTimeout,
	})
	if err != nil {
		return err
	}
	importServer, err := taskqueue.NewServer(asynq.Config{
		Concurrency:     kb.VisionImportWorkerConcurrency,
		Queues:          map[string]int{taskqueue.QueueDocumentImport: 1},
		RetryDelayFunc:  kb.AsynqRetryDelay,
		ErrorHandler:    errorHandler,
		ShutdownTimeout: workerShutdownTimeout,
	})
	if err != nil {
		return err
	}

	knowledgeMux := asynq.NewServeMux()
	knowledgeMux.HandleFunc(taskqueue.TypeKnowledgeBuild, kb.HandleKnowledgeBuildTask)
	importMux := asynq.NewServeMux()
	importMux.HandleFunc(taskqueue.TypeDocumentImport, kb.HandleDocumentImportTask)
	importMux.HandleFunc(taskqueue.TypeDocumentImportReconcile, kb.HandleDocumentImportReconcileTask)

	if err := knowledgeServer.Start(knowledgeMux); err != nil {
		return fmt.Errorf("启动知识构建 Asynq Worker 失败: %w", err)
	}
	if err := importServer.Start(importMux); err != nil {
		knowledgeServer.Shutdown()
		return fmt.Errorf("启动视觉导入 Asynq Worker 失败: %w", err)
	}

	scheduler, err := taskqueue.NewScheduler(&asynq.SchedulerOpts{Location: time.UTC})
	if err != nil {
		shutdownServers(knowledgeServer, importServer)
		return err
	}
	if _, err := scheduler.Register("@every 1m", taskqueue.NewDocumentImportReconcileTask(),
		asynq.Unique(55*time.Second)); err != nil {
		shutdownServers(knowledgeServer, importServer)
		return fmt.Errorf("注册视觉导入补偿任务失败: %w", err)
	}
	if err := scheduler.Start(); err != nil {
		shutdownServers(knowledgeServer, importServer)
		return fmt.Errorf("启动 Asynq 补偿调度器失败: %w", err)
	}
	if err := kb.EnqueueRunnableDocumentImports(startupCtx); err != nil {
		log.Printf("启动时补偿视觉导入任务失败，将由周期任务重试: %v", err)
	}

	workerCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("Petrichor Asynq Worker 已启动（知识构建并发=%d，视觉导入并发=%d）",
		cfg.KnowledgeBuild.Concurrency, kb.VisionImportWorkerConcurrency)
	<-workerCtx.Done()
	log.Print("收到关停信号，正在停止 Asynq 调度与任务处理")
	scheduler.Shutdown()
	shutdownServers(knowledgeServer, importServer)
	log.Print("Petrichor Asynq Worker 已安全关闭")
	return nil
}

func shutdownServers(servers ...*asynq.Server) {
	var wait sync.WaitGroup
	for _, server := range servers {
		if server == nil {
			continue
		}
		wait.Add(1)
		go func() {
			defer wait.Done()
			server.Shutdown()
		}()
	}
	wait.Wait()
}
