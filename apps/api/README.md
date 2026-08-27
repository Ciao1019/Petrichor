# Petrichor Go API（apps/api）

Go 服务接管 `/api/*`，Bun Web 服务负责托管 Vite SPA 并将 API 请求同源转发到 Go。

## 本地配置

Go 不读取环境变量，所有运行配置都来自 `apps/api/config.toml`：

```bash
cp apps/api/config.example.toml apps/api/config.toml
```

填写数据库、Session、加密、对象存储等配置后启动：

```bash
# 终端 1：Go API（默认 http://127.0.0.1:8080）
bun run dev:api

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
| `[agent.model]` | 预留的模型直连配置 |

开发免登录只能在 `server.environment = "development"` 时启用：

```toml
[auth.local_development]
enabled = true
user_id = 1
```

## 验证

```bash
cd apps/api
go build ./...
go vet ./...
go test ./...
```
