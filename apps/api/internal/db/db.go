package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

// Conn 封装 ent 客户端与底层 *sql.DB（向量检索等原生 SQL 使用）。
type Conn struct {
	Ent *ent.Client
	SQL *sql.DB
}

func Open(databaseURL string) (*Conn, error) {
	sqlDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("数据库连通性检查失败: %w", err)
	}

	drv := entsql.OpenDB(dialect.Postgres, sqlDB)
	return &Conn{
		Ent: ent.NewClient(ent.Driver(drv)),
		SQL: sqlDB,
	}, nil
}

func (c *Conn) Close() error {
	if c == nil {
		return nil
	}
	if c.Ent != nil {
		_ = c.Ent.Close()
	}
	if c.SQL != nil {
		return c.SQL.Close()
	}
	return nil
}
