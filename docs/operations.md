# 运行与运维

## 运行时基线

API 构建需要 Go `1.26.6` 或更新的安全补丁版本；Web 使用仓库 CI 固定的 Bun 版本。
Go 服务启动时先执行 Goose 迁移，迁移失败不会监听端口。

生产配置至少确认：

- `[server].trusted_proxies` 只包含真实入口代理 IP/CIDR；
- `[database].max_conns >= 6`，默认 10；后台 Worker 最多长期保留 4 个 advisory lock 连接；
- `[encryption]` 使用随机、稳定且非模板的 key/salt，并纳入密钥备份；
- HTTP 读取、响应头、空闲和优雅关闭超时保持有限值。

## 探针与关停

- `GET /healthz`：进程存活，不访问数据库；
- `GET /readyz`：数据库可用且迁移完成后返回成功；
- `GET /api/admin/runtime/metrics`：仅超级管理员可访问，返回 HTTP 聚合指标、pgx 连接池状态、
  知识构建和文档导入任务状态计数；
- `GET /api/admin/runtime/dead-letters`：列出耗尽自动重试的任务；
- `POST /api/admin/runtime/dead-letters/replay`：原子重置指定死信并交回持久队列。Web 管理端的
  “Worker 死信”页面提供相同操作入口。

收到 `SIGTERM`/`SIGINT` 后，服务先停止接收新请求，再取消后台 Worker，等待在途任务和 HTTP
连接退出，最后关闭数据库池。编排平台的终止宽限期应大于 `server.shutdown_timeout_seconds`。

## 可恢复后台任务

知识构建和 PDF 视觉导入都以 PostgreSQL 任务表作为事实来源，不依赖进程内 goroutine 状态：

1. Worker 通过 PostgreSQL advisory lock 取得跨实例全局并发槽；
2. 领取使用行锁/状态条件和 90 秒租约，20 秒心跳续租，避免同一任务并发执行；
3. 进程重启或 Worker 失联后，过期租约会被回收，未完成任务重新入队；
4. 可重试错误使用带稳定抖动、上限 5 分钟的指数退避，默认最多尝试 5 次；明确的业务 4xx
   直接失败，不浪费模型调用；
5. 知识构建按任务记录尝试次数，视觉导入按页面记录尝试次数；耗尽后进入 `dead_letter`，
   保留最后错误、死信时间和重放计数；
6. 超级管理员可在“Worker 死信”页面重放，重放会清零当前尝试次数，Worker 自动领取；
7. 知识构建普通终态保留 24 小时，死信保留 30 天；导入任务继续作为用户可见历史保留。

排障时先查看 `/api/admin/runtime/metrics` 的状态计数，再按日志中的 `requestId`、`jobId`、
`runId` 检索结构化日志。不要直接手工改任务状态；确需生产批量修复时，先评估范围、备份并走确认流程。

## 静态资源

`bun run build` 会为可压缩资源生成 `.br` 与 `.gz` 文件；`apps/web/server.ts` 按
`Accept-Encoding` 返回预压缩版本并设置 `Vary`。CI 的 `bun run check:bundle` 同时检查：

- 首屏 JS/CSS Brotli 传输体积不超过 350 KiB；
- 单个 JS chunk Brotli 体积不超过 600 KiB；
- 大于 1 KiB 的 JS 都存在 Brotli/Gzip 版本；
- About 头像使用小体积 AVIF。

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
