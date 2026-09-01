# 运行与运维

## 运行时基线

API 构建需要 Go `1.26.6` 或更新的安全补丁版本；Web 使用仓库 CI 固定的 Bun 版本。
Go API 启动时先执行 Goose 迁移，迁移失败不会监听端口；独立 Worker 必须在 API readiness
成功后启动，Compose 已通过依赖条件保证顺序。

生产配置至少确认：

- `[server].trusted_proxies` 只包含真实入口代理 IP/CIDR；
- `[database].max_conns >= 6`，默认 10；视觉导入 Worker 最多长期保留 2 个 advisory lock 连接；
- `[cache.redis].url = "redis://redis:6379/0"`，Redis 不发布公网端口；
- `[encryption]` 使用随机、稳定且非模板的 key/salt，并纳入密钥备份；
- HTTP 读取、响应头、空闲和优雅关闭超时保持有限值。

## 探针与关停

- `GET /healthz`：进程存活，不访问数据库；
- `GET /readyz`：数据库与 Redis（启用时）均可用且迁移完成后返回成功；
- `GET /api/admin/runtime/metrics`：仅超级管理员可访问，返回 HTTP 聚合指标、pgx 连接池状态、
  当前 API 进程的知识构建状态计数和数据库中的视觉导入状态计数；
- `GET /api/admin/runtime/dead-letters`：列出耗尽自动重试的视觉导入任务；
- `POST /api/admin/runtime/dead-letters/replay`：原子重置指定视觉导入死信并交回持久队列。

API 与视觉导入 Worker 是独立进程。API 收到 `SIGTERM`/`SIGINT` 后停止接收新请求，并取消
进程内正在执行的知识构建；这些任务需要重启后由用户重新发起。视觉导入 Worker 收到信号后取消
在途模型请求并等待任务 goroutine 退出，未释放租约会在 90 秒后回收。Compose 的
`stop_grace_period` 为 2 分钟，应始终大于 API 的 `server.shutdown_timeout_seconds`。

## 知识构建内存队列

单篇知识构建只把最终业务数据写入 PostgreSQL，中间任务状态和模型结果保存在 API 内存：

1. 默认 8 个 Go worker goroutine 从有界 channel 领取任务，队列最多等待 128 项；
2. 同一用户、知识库和文章的重复请求复用正在执行的任务；
3. 单任务最长执行 15 分钟，完成或失败状态在内存保留 1 小时供前端轮询；
4. 推荐问题与整文候选并行，推荐问题批次和页面物化默认各 8 路并发；所有文章共享一个
   64 路全局模型信号量，既能动态吃满额度，也不会发生嵌套任务池的并发乘法失控；
5. `[knowledge_build]` 可调整文章并发、队列长度、两类批次并发和全局模型并发，模型并发
   硬上限为 128；调整时同时评估模型供应商限流和费用；AI HTTP 客户端会复用高并发连接；
6. API 重启会丢失排队和执行状态，但最终落库使用事务，不会留下半套知识页面；用户重新构建即可；
7. 当前部署只支持一个 API 副本，多副本会导致状态轮询命中不同进程，不能直接横向扩容。

## 可恢复视觉导入任务

PDF 视觉导入以 PostgreSQL 任务表作为事实来源：

1. Worker 通过 PostgreSQL advisory lock 取得跨实例全局并发槽；
2. 领取使用行锁/状态条件和 90 秒租约，20 秒心跳续租；
3. 进程重启或 Worker 失联后，过期租约自动回收；
4. 可重试错误使用带稳定抖动、上限 5 分钟的指数退避，默认最多尝试 5 次；
5. 耗尽后进入 `dead_letter`，超级管理员可在“导入死信”页面重放。

排障时先查看 `/api/admin/runtime/metrics` 的状态计数，再按日志中的 `requestId`、`jobId`、
`runId` 检索结构化日志。不要直接手工改视觉导入任务状态。

## Redis 与任务边界

Redis 使用官方维护的 `github.com/redis/go-redis/v9` 客户端，连接池、重连和命令超时由该库
管理。Compose 启用 AOF、`allkeys-lru` 和 256 MiB 上限；Redis 不承载任务状态，因此清空或
重建 Redis 只会造成短暂缓存未命中。知识构建任务位于 API 内存，视觉导入的状态、租约、重试和
死信保存在 PostgreSQL。

## 静态资源

`bun run build` 会为可压缩资源生成 `.br` 与 `.gz` 文件；生产环境的 Caddy 优先发送预压缩
版本并设置长期静态资源缓存。本地 `apps/web/server.ts` 提供相同的 SPA 与 API 代理能力。CI 的
`bun run check:bundle` 同时检查：

- 首屏 JS/CSS Brotli 传输体积不超过 350 KiB；
- 单个 JS chunk Brotli 体积不超过 600 KiB；
- 大于 1 KiB 的 JS 都存在 Brotli/Gzip 版本；
- About 头像使用小体积 AVIF。

## Docker 运维

```bash
docker compose ps
docker compose logs -f api worker
docker compose restart worker
docker compose run --rm api migrate status
docker compose pull redis
docker compose up -d --build
```

只允许 `web` 暴露 80/443；API 的 8080 只通过 Compose `expose` 供 Caddy 使用，Redis 6379
只绑定宿主机回环地址。`app-data`、`redis-data` 与 `caddy-data` 是具名卷，升级前应连同
PostgreSQL、S3 数据和 `config.toml` 一起纳入备份计划。

## 发布前检查

```bash
bun install --cwd apps/web --frozen-lockfile
bun run typecheck
bun run lint
bun run test:coverage
bun run audit:web
bun run build
bun run check:bundle
bun run check:size

cd apps/api
go test ./...
go test -race ./...
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

需要真实数据库的只读集成测试仍按各文档声明的环境开关单独执行。
