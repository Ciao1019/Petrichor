#!/bin/sh
set -eu

config_path="/app/config.toml"
umask 077

if [ -n "${PETRICHOR_CONFIG_TOML:-}" ]; then
    printf '%s' "$PETRICHOR_CONFIG_TOML" > "$config_path"
    unset PETRICHOR_CONFIG_TOML
elif [ ! -f "$config_path" ]; then
    echo "缺少 /app/config.toml 或 PETRICHOR_CONFIG_TOML" >&2
    exit 1
fi

# Vercel 可用独立 Secret 覆盖数据库连接，其余配置仍来自完整 TOML。
if [ -n "${PETRICHOR_DATABASE_URL:-}" ] || [ -n "${PETRICHOR_MIGRATION_DATABASE_URL:-}" ]; then
    if [ -z "${PETRICHOR_DATABASE_URL:-}" ] || [ -z "${PETRICHOR_MIGRATION_DATABASE_URL:-}" ]; then
        echo "PETRICHOR_DATABASE_URL 与 PETRICHOR_MIGRATION_DATABASE_URL 必须同时配置" >&2
        exit 1
    fi
    case "$PETRICHOR_DATABASE_URL:$PETRICHOR_MIGRATION_DATABASE_URL" in
        *'"'*|*[[:space:]]*)
            echo "数据库连接串包含不支持的字符" >&2
            exit 1
            ;;
    esac
    awk -v runtime_url="$PETRICHOR_DATABASE_URL" -v migration_url="$PETRICHOR_MIGRATION_DATABASE_URL" '
        /^\[database\][[:space:]]*$/ { in_database = 1; print; next }
        in_database && /^\[/ { in_database = 0 }
        in_database && /^[[:space:]]*url[[:space:]]*=/ {
            print "url = \"" runtime_url "\""
            next
        }
        in_database && /^[[:space:]]*migration_url[[:space:]]*=/ {
            print "migration_url = \"" migration_url "\""
            next
        }
        { print }
    ' "$config_path" > "$config_path.tmp"
    mv "$config_path.tmp" "$config_path"
    unset PETRICHOR_DATABASE_URL PETRICHOR_MIGRATION_DATABASE_URL
fi

exec /app/petrichor-api
