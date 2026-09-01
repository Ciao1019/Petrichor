#!/usr/bin/env bash
set -euo pipefail

# Gin Context 虽然实现了 context.Context，但请求取消语义应显式来自 Request.Context。
# 阻止数据库调用重新传入 *gin.Context，Worker/启动/清理所需的独立 context 不受影响。
matches="$({
  grep -RInE '\.(Exec|Query|QueryRow|Begin|BeginTx|Commit|Rollback)\(c([,)]|$)' apps/api/internal \
    --include='*.go' --exclude='*_test.go' || true
} | grep -v '/vendor/' || true)"

if [[ -n "$matches" ]]; then
  echo "错误：发现数据库调用直接使用 Gin Context；请改为 c.Request.Context()："
  echo "$matches"
  exit 1
fi

echo "Go 请求 Context 检查通过。"
