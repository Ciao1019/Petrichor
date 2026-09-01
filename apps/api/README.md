# Petrichor Go API（apps/api）

Go API 接管 `/api/*`；生产环境由 Caddy 托管 Vite SPA 并同源反向代理 API。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `cmd/server` | API 服务进程入口，自动迁移并运行知识构建内存队列 |
| `cmd/worker` | 视觉导入常驻 Worker 入口 |
| `cmd/migrate` | Goose 状态查看与手动执行入口 |
| `internal/routes` | Gin 路由集中注册 |
| `internal/auth` | Sa-Token 登录、会话、OAuth 和 API Key 鉴权 |
| `internal/satokenstore` | Sa-Token PostgreSQL 持久化适配器 |
| `internal/aicore` / `internal/aisvc` | 模型协议、供应商和 AI 业务能力 |
| `internal/assistantsvc` / `internal/agentapi` | 站内助手运行时和对外 Agent API |
| `internal/kb` / `internal/doclibrary` | 知识库、Wiki、文章与文档库 |
| `internal/publicapi` / `internal/sitecontent` | 公开站点接口和展示内容 |
| `internal/db` / `internal/dbmigrate` | 数据库连接和 Goose 装配 |
| `internal/storage` / `internal/cache` | 对象存储和缓存基础设施 |
| `migrations` | 内嵌到 Go 产物的 Goose 初始化基线与后续迁移 |

## 本地配置

Go 不读取环境变量，所有运行配置都来自 `apps/api/config.toml`：

```bash
cp apps/api/config.example.toml apps/api/config.toml
```

填写数据库、Session、加密、对象存储等配置后启动。直接在宿主机运行 Go 时，将 Redis URL
设为 `redis://127.0.0.1:6379/0`，并通过 `docker compose up -d redis` 启动本地 Redis：

```bash
# 终端 1：Go API（默认 http://127.0.0.1:8080）
cd apps/api && go run ./cmd/server

# 终端 2：常驻视觉导入任务
cd apps/api && go run ./cmd/worker

# 终端 3：Bun/Vite Web（默认 http://127.0.0.1:3000）
bun dev
```

`config.toml` 含密钥，已加入 Git 与 Docker 忽略清单，文件权限建议保持 `0600`。可提交模板只有 `config.example.toml`。

## 配置结构

| TOML 区段 | 用途 |
| --- | --- |
| `[server]` | 环境、监听地址、端口和公开站点 URL |
| `[database]` | PostgreSQL 连接与迁移连接 |
| `[auth]` | Session、注册策略、LinuxDo、本地开发免登录 |
| `[encryption]` | AI 凭证加密密钥与盐 |
| `[storage]` / `[storage.s3]` | 本地目录与 S3 兼容对象存储 |
| `[cache.redis]` | go-redis TCP 连接、连接池和命令超时 |
| `[knowledge_build]` | 知识构建文章并发、内存队列和模型批次并发 |
| `[agent.features]` | Agent Runtime 功能开关 |
| `[agent.budget]` | Agent 预算、超时、重试和上下文限制 |
| `[agent.research]` | 可选外部搜索供应商与超时 |

开发免登录只能在 `server.environment = "development"` 时启用：

```toml
[auth.local_development]
enabled = true
user_id = 1
```

## 数据库迁移

完整数据库结构由 `apps/api/migrations/202608270002_init.sql` 提供，后续安全和结构变更使用
更高版本迁移，并统一由 Goose 内嵌进 Go 程序。`go run ./cmd/server` 会在监听端口前自动执行；
失败时 API 不会启动。

首次初始化不创建默认账号，Web 会通过 `/api/auth/setup` 让部署者设置管理员名称、登录
邮箱和密码，并原子创建第一个超级管理员。初始化只能成功一次；完成前普通登录和
所有受保护接口都会返回 `409`。需要排查迁移状态时使用纯 Go 命令：

```bash
go run ./cmd/migrate status
go run ./cmd/migrate version
go run ./cmd/migrate up
```

执行器优先使用 `[database].migration_url`，留空时回退到 `url`。数据库迁移与 Bun、Web
环境和前端构建完全无关。

## Docker 镜像

`Dockerfile` 一次构建 `petrichor-api`、`petrichor-worker` 与 `petrichor-migrate` 三个静态 Go
产物，由入口脚本按 Compose command 选择。真实 `config.toml` 通过 Compose secret 挂载，
不会复制到构建上下文或镜像层；容器全程以非 root 的 `petrichor` 用户运行。

知识构建由 API 进程中的 Go channel 和固定 worker goroutine 调度，状态及中间结果只保存在内存，
最终切片、Wiki 页面、关系和向量索引事务写入 PostgreSQL。视觉导入仍使用 PostgreSQL 任务表、
租约、心跳和 advisory lock 保证恢复。Redis 只做缓存，不参与任务可靠性。

## 验证

```bash
cd apps/api
go build ./...
go vet ./...
go test ./...
```
