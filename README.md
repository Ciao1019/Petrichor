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
- `server.ts`：Bun Web 入口，托管前端静态资源并将 `/api/*`、`/healthz` 同源转发到 Go。
- 数据库使用 PostgreSQL，支持 Supabase transaction pooler；上传使用 S3 兼容对象存储。

## 功能

| 模块 | 能力 |
| --- | --- |
| 富文本编辑器 | PlateJS、Markdown、代码块、表格、公式、白板、思维导图和媒体嵌入 |
| 知识库 | 多级目录、标签、搜索、文章分享、RSS / Atom |
| AI 助手 | 续写、改写、翻译、总结、文档问答和 Agent Runtime |
| 认证 | 邮箱密码、httpOnly Cookie、LinuxDo OAuth、会话管理 |
| 对象存储 | S3 兼容上传和预签名 URL |
| Agent 集成 | API Key、MCP、可下载 Skill 包、REST 能力和调用审计 |

## 本地开发

前置要求：Bun 1.3.14+、Go（版本以 `apps/api/go.mod` 为准）和 PostgreSQL。

```bash
bun install
cp apps/web/.env.example apps/web/.env.local
cp apps/api/config.example.toml apps/api/config.toml
```

编辑两个本地配置文件后，分别启动后端和 Web：

```bash
# 终端 1，默认 http://127.0.0.1:8080
bun run dev:api

# 终端 2，默认 http://127.0.0.1:3000
bun dev
```

初始化数据库 SQL：

```bash
bun --silent run db:sql > petrichor-init.sql
```

## 配置

### Go 后端

Go **不读取环境变量**。所有运行配置统一来自 `apps/api/config.toml`，可提交模板为
[`apps/api/config.example.toml`](apps/api/config.example.toml)：

| TOML 区段 | 内容 |
| --- | --- |
| `[server]` | 运行环境、监听地址、端口、公开站点 URL |
| `[database]` | PostgreSQL 运行连接和迁移连接 |
| `[auth]` | Session、注册策略、LinuxDo、本地开发免登录 |
| `[encryption]` | 数据库内 AI 凭证的加密密钥和盐 |
| `[storage]` / `[storage.s3]` | 本地存储和 S3 兼容对象存储 |
| `[cache.upstash]` | Upstash Redis REST 缓存 |
| `[agent.features]` | Agent Runtime 功能开关 |
| `[agent.budget]` | 迭代、工具调用、超时、重试和上下文预算 |
| `[agent.model]` | 预留的模型直连配置 |

`config.toml` 包含数据库连接串和密钥，已被 Git 与 Docker 忽略。不要提交或输出真实内容；
`auth.session_secret`、`encryption.key` 和 `encryption.salt` 一旦用于真实数据，不要随意更换。

从旧版 Web 环境文件迁移一次可使用：

```bash
bun run migrate:go-config
```

脚本只在 `apps/api/config.toml` 不存在时创建文件，并会从 Web 环境文件中移除后端键，避免覆盖已有配置。

### Web 前端

[`apps/web/.env.example`](apps/web/.env.example) 只包含 Web 所需配置：

- `NEXT_PUBLIC_*`、`PETRICHOR_PUBLIC_*`、`VITE_*`：浏览器可见的公开配置。
- `PETRICHOR_GO_API_URL`：Bun Web 代理的 Go API 地址，不会作为 Vite 客户端变量暴露。

数据库、Session、加密、S3、LinuxDo、Upstash 和 Agent 配置不得再写入 Web 环境文件。

## 常用命令

```bash
bun dev              # 启动 Bun/Vite Web
bun run dev:api      # 启动 Go API
bun run typecheck    # TypeScript 类型检查
bun run lint         # ESLint
bun run test         # Vitest
bun run build        # Vite 生产构建
bun run test:api     # Go 测试
bun run build:api    # Go 构建
```

完整 Go 检查：

```bash
cd apps/api
go test ./...
go vet ./...
```

## 项目结构

```text
.
├── apps/
│   ├── api/                       # Go API
│   │   ├── cmd/server/            # 服务入口
│   │   ├── internal/              # 业务、鉴权、数据、存储、Agent
│   │   └── config.example.toml    # 可提交的配置模板
│   └── web/                       # React/Vite SPA
│       ├── src/main.tsx           # Vite 入口
│       ├── src/client-app.tsx     # 客户端路由入口
│       ├── src/features/pages/    # 业务页面
│       ├── src/components/        # 通用和 UI 组件
│       └── .env.example           # 仅 Web 配置
├── docs/                          # SQL、迁移和设计文档
├── scripts/                       # Bun 开发与迁移脚本
└── server.ts                      # Bun 静态服务与 Go 反代
```

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
