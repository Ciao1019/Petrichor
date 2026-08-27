package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/pressly/goose/v3"

	"petrichor/api/internal/config"
	"petrichor/api/internal/dbmigrate"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "数据库迁移失败:", err)
		os.Exit(1)
	}
}

func run() error {
	command := "up"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if len(os.Args) > 2 {
		return usageError()
	}
	if command != "up" && command != "status" && command != "version" {
		return usageError()
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	provider, err := dbmigrate.OpenConfig(cfg)
	if err != nil {
		return err
	}
	defer provider.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch command {
	case "up":
		return runUp(ctx, provider)
	case "status":
		return printStatus(ctx, provider)
	case "version":
		return printVersion(ctx, provider)
	default:
		return usageError()
	}
}

func runUp(ctx context.Context, provider *goose.Provider) error {
	results, err := provider.Up(ctx)
	if err != nil {
		return err
	}
	if len(results) == 0 {
		fmt.Println("数据库迁移已是最新版本")
		return nil
	}
	for _, result := range results {
		fmt.Printf("已执行 %s（%s）\n", filepath.Base(result.Source.Path), result.Duration)
	}
	fmt.Printf("数据库迁移完成，共执行 %d 个迁移\n", len(results))
	return nil
}

func printStatus(ctx context.Context, provider *goose.Provider) error {
	statuses, err := provider.Status(ctx)
	if err != nil {
		return err
	}
	for _, status := range statuses {
		appliedAt := "-"
		if status.State == goose.StateApplied {
			appliedAt = status.AppliedAt.Local().Format("2006-01-02 15:04:05")
		}
		fmt.Printf("%-7s %d %s %s\n", status.State, status.Source.Version, filepath.Base(status.Source.Path), appliedAt)
	}
	return nil
}

func printVersion(ctx context.Context, provider *goose.Provider) error {
	version, err := provider.GetDBVersion(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("当前数据库迁移版本: %d\n", version)
	return nil
}

func usageError() error {
	return fmt.Errorf("用法: go run ./cmd/migrate [up|status|version]")
}
