#!/bin/sh
set -eu

runtime_config=/app/config.toml
secret_config=/run/secrets/petrichor_config

if [ -f "$secret_config" ]; then
  cp "$secret_config" "$runtime_config"
  chmod 600 "$runtime_config"
elif [ ! -f "$runtime_config" ]; then
  echo "缺少 Go 配置：请通过 Docker Compose secret 提供 apps/api/config.toml" >&2
  exit 1
fi

command_name=${1:-server}
case "$command_name" in
  server)
    shift || true
    exec /app/petrichor-api "$@"
    ;;
  worker)
    shift || true
    exec /app/petrichor-worker "$@"
    ;;
  migrate)
    shift || true
    exec /app/petrichor-migrate "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
