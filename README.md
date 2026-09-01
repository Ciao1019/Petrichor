<div align="center">

<img src="apps/web/public/sidebar-logo.jpg" alt="Petrichor" width="120" height="120" />

# Petrichor

**一个基于 Bun/Vite、Go 与 PostgreSQL 的知识库和博客平台**

*A self-hostable knowledge-base and blog platform powered by Bun/Vite, Go and PostgreSQL.*

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.3-black?logo=bun)](https://bun.sh)
[![Go](https://img.shields.io/badge/Go-API-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)

[**产品介绍**](https://wl.do/tags) · [**在线 Demo**](https://wl.do) · [功能](#功能) · [本地开发](#本地开发) · [配置](#配置)

</div>

## 架构

- `apps/web`：React + Vite + TypeScript 客户端 SPA，依赖和运行时统一使用 Bun。
- `apps/api`：Go + Gin API，负责数据库、认证、加密、对象存储、缓存和 Agent 能力。
- `apps/web/server.ts`：Bun Web 入口，托管前端静态资源并将 `/api/*`、`/healthz` 同源转发到 Go。
- 数据库使用 PostgreSQL，Go 服务启动时通过 Goose 自动初始化或升级；上传使用 S3 兼容对象存储。

## 功能

| 模块 | 能力 |
| --- | --- |
| 富文本编辑器 | PlateJS、Markdown、代码块、表格、公式、白板、思维导图和媒体嵌入 |
| 知识库 | 多级目录、标签、搜索、文章分享、RSS / Atom |
| 知识可移植 | OKF / Obsidian 导出、Agent Skill 包蒸馏、知识库级编译说明书、陈旧检测 |
| AI 助手 | 续写、改写、翻译、总结、文档问答和 Agent Runtime |
| 认证 | Sa-Token-Go、邮箱密码、httpOnly Cookie、LinuxDo OAuth、会话管理 |
| 对象存储 | S3 兼容上传和预签名 URL |
| Agent 集成 | API Key、MCP、可下载 Skill 包、REST 能力和调用审计 |

## 本地开发

前置要求：Bun 1.3.14+、Go（版本以 `apps/api/go.mod` 为准）和 PostgreSQL。

```bash
bun install --cwd apps/web
cp apps/web/.env.example apps/web/.env.local
cp apps/api/config.example.toml apps/api/config.toml
```

编辑两个本地配置文件后，分别启动后端和 Web。Go API 会在监听端口前自动执行全部
待执行迁移：

```bash
# 终端 1，默认 http://127.0.0.1:8080
cd apps/api && go run ./cmd/server

# 终端 2，默认 http://127.0.0.1:3000
bun dev
```

首次启动只创建最终表结构，不写入任何默认账号。第一次打开站点时，Web 会强制进入管理员
初始化页，由部署者自行设置管理员名称、登录邮箱和密码。初始化接口使用数据库事务锁，
只能成功执行一次；完成前普通登录和后台接口均不可用。

数据库命令完全由 Go 提供，通常无需手动执行：

```bash
cd apps/api
go run ./cmd/migrate status
go run ./cmd/migrate version
```

## Vercel 容器部署

仓库根目录的 `vercel.json` 使用 Vercel Services，将 Web 和 Go API 分别构建为
`Dockerfile.vercel` 容器。`/api/*` 与 `/healthz` 路由到 Go 服务，其余请求路由到 Web
服务。

Go 容器不会把 `config.toml` 打包进镜像。部署时应将完整文件内容保存到 Vercel 加密环境
变量 `PETRICHOR_CONFIG_TOML`；容器启动后会以 `0600` 权限还原为 `/app/config.toml`。
若数据库连接需要独立管理，可同时设置 `PETRICHOR_DATABASE_URL` 与
`PETRICHOR_MIGRATION_DATABASE_URL`，容器只用它们覆盖 TOML 的 `[database]` 段。项目环境
变量 `PORT` 应设置为 `8080`。

## 配置

### Go 后端

Go **不读取环境变量**。所有运行配置统一来自 `apps/api/config.toml`，可提交模板为
[`apps/api/config.example.toml`](apps/api/config.example.toml)：

| TOML 区段 | 内容 |
| --- | --- |
| `[server]` | 运行环境、监听地址、可信代理、HTTP 超时和公开站点 URL |
| `[database]` | PostgreSQL 运行/迁移连接与连接池生命周期参数 |
| `[auth]` | Session、注册策略、LinuxDo、本地开发免登录 |
| `[encryption]` | 数据库内 AI 凭证的加密密钥和盐 |
| `[storage]` / `[storage.s3]` | 本地存储和 S3 兼容对象存储 |
| `[cache.upstash]` | Upstash Redis REST 缓存 |
| `[agent.features]` | Agent Runtime 功能开关 |
| `[agent.budget]` | 迭代、工具调用、超时、重试和上下文预算 |
| `[agent.research]` | 可选外部搜索供应商与超时 |

`config.toml` 包含数据库连接串和密钥，已被 Git 与 Docker 忽略。不要提交或输出真实内容；
`encryption.key` 和 `encryption.salt` 一旦用于真实数据，不要随意更换。生产环境会拒绝模板/弱加密值；
`server.trusted_proxies` 只能配置真实入口代理，数据库连接池 `max_conns` 至少为 6。

### Web 前端

[`apps/web/.env.example`](apps/web/.env.example) 只包含 Web 所需配置：

- `PETRICHOR_PUBLIC_*`、`VITE_*`：浏览器可见的公开配置。
- `PETRICHOR_GO_API_URL`：Bun Web 代理的 Go API 地址，不会作为 Vite 客户端变量暴露。

数据库、Session、加密、S3、LinuxDo、Upstash 和 Agent 配置不得再写入 Web 环境文件。

## 常用命令

```bash
bun dev              # 启动 Bun/Vite Web
bun run typecheck    # TypeScript 类型检查
bun run lint         # ESLint
bun run test         # Vitest
bun run test:coverage # 覆盖率棘轮
bun run build        # Vite 生产构建 + Brotli/Gzip 预压缩
bun run check:bundle # 首屏与 chunk 传输体积预算
bun run test:api     # Go 测试
bun run build:api    # Go 构建
cd apps/api && go run ./cmd/server  # 自动迁移并启动 Go API
cd apps/api && go run ./cmd/migrate status  # 查看 Goose 状态
```

完整 Go 检查：

```bash
cd apps/api
go test ./...
go test -race ./...
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

探针、优雅关停、后台任务恢复、运行指标和发布检查见
[`docs/operations.md`](docs/operations.md)，安全报告与部署基线见 [`SECURITY.md`](SECURITY.md)。

## 项目结构

```text
.
├── apps/
│   ├── api/                       # Go API
│   │   ├── cmd/
│   │   │   ├── server/            # API 服务入口
│   │   │   └── migrate/           # Goose 命令入口
│   │   ├── internal/              # Go 私有业务实现
│   │   ├── migrations/            # Goose 初始化基线与嵌入代码
│   │   └── config.example.toml    # 可提交的配置模板
│   └── web/                       # React/Vite SPA
│       ├── src/
│       │   ├── main.tsx           # Vite 浏览器入口
│       │   ├── client-app.tsx     # 客户端路由入口
│       │   ├── features/          # 业务功能与页面
│       │   ├── components/        # 通用和 UI 组件
│       │   └── lib/               # 浏览器侧工具与 API client
│       ├── public/                # 静态资源
│       ├── scripts/               # Web 开发与生成脚本
│       ├── server.ts              # Bun 静态服务与 Go 反代
│       ├── patches/               # Web 依赖补丁
│       ├── bun.lock               # Web 依赖锁文件
│       └── .env.example           # 仅 Web 配置
├── docs/
│   ├── agent/                     # Agent 设计与接入文档
│   └── database-migrations.md     # Goose 迁移说明
├── package.json                   # 根命令入口，不承载 Web 依赖
├── AGENTS.md                      # 项目协作规范
└── CONTRIBUTING.md                # 贡献流程
```

根目录不安装 Node 依赖，也不保存前后端源码；`package.json` 只把常用命令转发到对应应用。
`node_modules`、`dist`、本地配置和 IDE/Agent 工具目录均被 Git 忽略，不属于仓库结构。

## 贡献

欢迎 Issue 和 PR。协作规范见 [`AGENTS.md`](AGENTS.md)，提交流程见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。提交前至少运行：

```bash
bun run typecheck
bun run lint
bun run test
bun run build
cd apps/api && go test ./... && go vet ./...
```

## 致谢

- 公开站点 UI 与排版设计借鉴自 [astro-theme-retypeset](https://github.com/radishzzz/astro-theme-retypeset)。
- 感谢 [LinuxDo](https://linux.do/) 社区的支持。

## License

[Apache License 2.0](LICENSE) © 2026 Petrichor Contributors
