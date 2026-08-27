// Package dbmigrate 创建使用内嵌 SQL 的 Goose 迁移执行器。
package dbmigrate

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"petrichor/api/internal/config"
	"petrichor/api/migrations"
)

// OpenConfig 使用 Go 服务配置创建迁移执行器。
func OpenConfig(cfg *config.Config) (*goose.Provider, error) {
	if cfg == nil {
		return nil, fmt.Errorf("数据库迁移配置不能为空")
	}
	databaseURL := cfg.MigrationDatabaseURL
	if databaseURL == "" {
		databaseURL = cfg.DatabaseURL
	}
	return Open(databaseURL)
}

// Up 执行所有尚未应用的迁移，并在结束后释放数据库连接。
func Up(ctx context.Context, cfg *config.Config) ([]*goose.MigrationResult, error) {
	provider, err := OpenConfig(cfg)
	if err != nil {
		return nil, err
	}
	defer provider.Close()
	return provider.Up(ctx)
}

// Open 创建 PostgreSQL Goose Provider。调用方必须调用 Close 释放连接。
func Open(databaseURL string) (*goose.Provider, error) {
	databaseURL = strings.TrimSpace(databaseURL)
	if databaseURL == "" {
		return nil, fmt.Errorf("数据库迁移连接不能为空")
	}

	pgxConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("解析数据库迁移连接失败: %w", err)
	}
	// 兼容 Supabase transaction pooler，不使用 prepared statement 缓存。
	pgxConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	database := stdlib.OpenDB(*pgxConfig)

	locker, err := lock.NewPostgresTableLocker()
	if err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("创建数据库迁移锁失败: %w", err)
	}
	provider, err := goose.NewProvider(
		goose.DialectPostgres,
		database,
		migrations.Files,
		goose.WithLocker(locker),
	)
	if err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("创建 Goose 迁移执行器失败: %w", err)
	}
	return provider, nil
}
