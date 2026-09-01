// Package db 提供 pgx 连接池；沿用 transaction pooler 场景下禁用预编译语句的约束。
package db

import (
	"context"
	"log/slog"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/config"
)

var (
	poolOnce sync.Once
	poolIns  *pgxpool.Pool
	poolErr  error
)

// Initialize 在启动阶段创建并探测全局连接池，调用方可正常处理错误而不是依赖 panic。
func Initialize(ctx context.Context) error {
	poolOnce.Do(func() {
		appConfig := config.Get()
		cfg, err := pgxpool.ParseConfig(appConfig.DatabaseURL)
		if err != nil {
			poolErr = err
			return
		}
		// Supabase transaction pooler 下不能使用 prepared statement 缓存。
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
		cfg.MaxConns = appConfig.DatabasePool.MaxConns
		cfg.MinConns = appConfig.DatabasePool.MinConns
		cfg.MaxConnLifetime = appConfig.DatabasePool.MaxConnLifetime
		cfg.MaxConnIdleTime = appConfig.DatabasePool.MaxConnIdleTime
		cfg.HealthCheckPeriod = appConfig.DatabasePool.HealthCheckPeriod
		poolIns, poolErr = pgxpool.NewWithConfig(ctx, cfg)
		if poolErr != nil {
			return
		}
		if err := poolIns.Ping(ctx); err != nil {
			poolIns.Close()
			poolIns = nil
			poolErr = err
		}
	})
	return poolErr
}

// Pool 返回已初始化的全局连接池。生产入口应先调用 Initialize。
func Pool() *pgxpool.Pool {
	if err := Initialize(context.Background()); err != nil {
		slog.Error("数据库连接失败", "err", err)
		panic(err)
	}
	return poolIns
}

// Ping 用于 readiness 探测。
func Ping(ctx context.Context) error {
	if err := Initialize(ctx); err != nil {
		return err
	}
	return poolIns.Ping(ctx)
}

// Close 在服务优雅关闭时释放连接。
func Close() {
	if poolIns != nil {
		poolIns.Close()
	}
}
