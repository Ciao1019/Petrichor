# Petrichor Go API（apps/api）

Go API 接管 `/api/*`；生产环境由 Caddy 托管 Vite SPA 并同源反向代理 API。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `cmd/server` | API 服务进程入口，自动迁移并向 Asynq 写入后台任务 |
| `cmd/worker` | 知识构建与视觉导入 Asynq Worker 入口 |
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
| `internal/taskqueue` | Asynq 任务协议、入队去重、状态与 Redis 装配 |
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

# 终端 2：Asynq 知识构建与视觉导入任务
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
| `[cache.redis]` | 缓存与 Asynq 共用的 Redis TCP 连接、连接池和命令超时 |
| `[knowledge_build]` | 知识构建 Asynq Worker 并发、队列软上限和模型批次并发 |
| `[agent]` | 可选外部 Agent Skill 资源目录；留空时不提供 ZIP Skill 包 |
| `[agent.features]` | Agent Runtime 功能开关 |
| `[agent.budget]` | Agent 预算、超时、重试和上下文限制 |
| `[agent.research]` | 可选外部搜索供应商与超时 |

当前仓库和默认 API 镜像不内置外部 Agent Skill 资源目录，因此 `/api/agent/skill-pack` 默认返回
404；无需 ZIP 时使用 `/api/agent/skill` 单文件或 MCP。若配置 `skills_directory`，Docker 部署还要
把对应目录挂载到 API 容器可读路径。

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

公开镜像 [`ghcr.io/ciao1019/petrichor-api`](https://github.com/users/Ciao1019/packages/container/package/petrichor-api)
支持 `linux/amd64` 与 `linux/arm64`：

```bash
docker pull ghcr.io/ciao1019/petrichor-api:latest
```

`latest` 与 `master` 指向当前发布版本，`sha-<12 位提交哈希>` 用于不可变部署。API、Worker 和
Migrate 共用同一镜像，由入口脚本分别选择 `server`、`worker` 和 `migrate` 命令；完整部署请使用
仓库根目录的 `compose.yaml`。

API 只负责把任务写入 Redis；`cmd/worker` 使用 Asynq 的两个独立队列消费知识构建与视觉导入。
知识构建阶段进度与结果在 Redis 保留 1 小时供前端轮询；模型临时错误在当前阶段最多尝试 3 次，
最终切片、Wiki 页面、关系和向量索引事务写入 PostgreSQL。视觉导入的任务、页进度、重试和死信
业务状态也统一保存在 Redis，并由每分钟一次的
Asynq 补偿任务恢复极小窗口内的入队失败。Redis 必须启用持久化和 `noeviction`，不再允许仅把它
视为可丢缓存。根 Compose 同时启动官方 `asynqmon`，默认仅监听 `127.0.0.1:8081`。

## 验证

```bash
cd apps/api
go build ./...
go vet ./...
go test ./...
```
