// Package migrations 内嵌数据库初始化基线及后续版本迁移，确保发布产物与 SQL 版本一致。
package migrations

import "embed"

// Files 包含全部 Goose SQL 迁移，由 Go 服务启动时按版本自动执行。
//
//go:embed *.sql
var Files embed.FS
