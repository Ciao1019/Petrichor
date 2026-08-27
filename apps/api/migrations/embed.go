// Package migrations 内嵌数据库初始化基线，确保发布产物与 SQL 版本一致。
package migrations

import "embed"

// Files 包含 Goose 初始化 SQL。
//
//go:embed *.sql
var Files embed.FS
