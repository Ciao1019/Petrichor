#!/usr/bin/env bash
#
# 模块行数守门。规则是一条棘轮，不是一次性大重构：
#
#   1. 新文件不得超过 LIMIT 行；
#   2. 基线里记录的历史大文件可以超限，但不得再长；
#   3. 基线里的文件降到限额以下，或已被删除，必须把那一行从基线里去掉。
#
# 用法：
#   scripts/check-file-size.sh            检查
#   scripts/check-file-size.sh --update   按当前状态重写基线（需要人工确认再提交）
#
# 生成式 UI 组件（shadcn / extend / assistant-ui / tool-ui）保持生成时形态，
# 不参与本检查——见 AGENTS.md「TypeScript 与代码风格」。

set -euo pipefail

LIMIT=800
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$ROOT/scripts/file-size-baseline.txt"

cd "$ROOT"

# collect_sources 列出参与检查的源文件，路径相对仓库根。
collect_sources() {
  {
    find apps/api -name '*.go' ! -name '*_test.go'
    find apps/web/src \( -name '*.ts' -o -name '*.tsx' \) \
      ! -name '*.test.ts' ! -name '*.test.tsx' \
      ! -path 'apps/web/src/components/ui/*' \
      ! -path 'apps/web/src/components/extend/*' \
      ! -path 'apps/web/src/components/assistant-ui/*' \
      ! -path 'apps/web/src/components/tool-ui/*'
  } | sort
}

# line_count 输出文件行数。
line_count() {
  awk 'END { print NR }' "$1"
}

if [ "${1:-}" = "--update" ]; then
  {
    echo "# 模块行数基线：历史遗留的超长文件及其当前行数上限。"
    echo "# 由 scripts/check-file-size.sh --update 生成，只能变小，不能变大。"
    collect_sources | while read -r file; do
      lines="$(line_count "$file")"
      if [ "$lines" -gt "$LIMIT" ]; then
        echo "$lines $file"
      fi
    done
  } > "$BASELINE"
  echo "已重写基线：$BASELINE"
  exit 0
fi

failed=0

# 读基线到两个平行数组（兼容 bash 3.2，不用关联数组）。
baseline_files=""
baseline_limits=""
if [ -f "$BASELINE" ]; then
  while read -r lines file; do
    case "$lines" in ''|'#'*) continue ;; esac
    baseline_files="$baseline_files$file
"
    baseline_limits="$baseline_limits$file $lines
"
  done < "$BASELINE"
fi

baseline_limit_of() {
  printf '%s' "$baseline_limits" | awk -v f="$1" '$2 != "" && $1 == f { print $2; exit }'
}

in_baseline() {
  printf '%s' "$baseline_files" | grep -qxF "$1"
}

# 1 / 2：逐个源文件对照限额。
while read -r file; do
  lines="$(line_count "$file")"
  if in_baseline "$file"; then
    allowed="$(baseline_limit_of "$file")"
    if [ "$lines" -gt "$allowed" ]; then
      echo "错误：$file 有 $lines 行，超过基线记录的 $allowed 行。历史大文件只能变小。"
      failed=1
    elif [ "$lines" -le "$LIMIT" ]; then
      echo "错误：$file 已降到 $lines 行（≤ ${LIMIT}），请从 $BASELINE 删掉这一行。"
      failed=1
    fi
  elif [ "$lines" -gt "$LIMIT" ]; then
    echo "错误：$file 有 $lines 行，超过上限 $LIMIT 行。请拆分，或在确有理由时写进基线并说明原因。"
    failed=1
  fi
done <<EOF
$(collect_sources)
EOF

# 3：基线里指向已删除文件的行。
printf '%s' "$baseline_files" | while read -r file; do
  [ -n "$file" ] || continue
  if [ ! -f "$file" ]; then
    echo "错误：基线记录的 $file 已不存在，请删掉这一行。"
    exit 1
  fi
done || failed=1

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "模块行数检查通过（上限 $LIMIT 行）。"
