# Petrichor Go API（apps/api）

Go 服务接管 `/api/*`，Bun Web 服务负责托管 Vite SPA 并将 API 请求同源转发到 Go。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `cmd/server` | API 服务进程入口 |
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

填写数据库、Session、加密、对象存储等配置后启动：

```bash
# 终端 1：Go API（默认 http://127.0.0.1:8080）
cd apps/api && go run ./cmd/server

# 终端 2：Bun/Vite Web（默认 http://127.0.0.1:3000）
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
| `[cache.upstash]` | Upstash Redis REST 缓存 |
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

## Vercel 容器

`Dockerfile.vercel` 构建独立 Go API 镜像。镜像不包含真实 `config.toml`，运行时由
`docker-entrypoint.sh` 从 Vercel 加密环境变量 `PETRICHOR_CONFIG_TOML` 还原配置，随后启动
API 并自动执行 Goose 迁移。可用成对的 `PETRICHOR_DATABASE_URL`、
`PETRICHOR_MIGRATION_DATABASE_URL` Secret 单独覆盖 `[database]`；容器监听 `8080`。

## 验证

```bash
cd apps/api
go build ./...
go vet ./...
go test ./...
```
