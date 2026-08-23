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

// Pool 返回全局连接池。
func Pool() *pgxpool.Pool {
	poolOnce.Do(func() {
		cfg, err := pgxpool.ParseConfig(config.Get().DatabaseURL)
		if err != nil {
			poolErr = err
			return
		}
		// Supabase transaction pooler 下不能使用 prepared statement 缓存。
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
		cfg.MaxConns = 10
		ctx := context.Background()
		poolIns, poolErr = pgxpool.NewWithConfig(ctx, cfg)
		if poolErr != nil {
			return
		}
		if err := poolIns.Ping(ctx); err != nil {
			poolErr = err
		}
	})
	if poolErr != nil {
		slog.Error("数据库连接失败", "err", poolErr)
		panic(poolErr)
	}
	return poolIns
}
