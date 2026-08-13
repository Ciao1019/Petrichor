<div align="center">

<img src="apps/web/public/sidebar-logo.jpg" alt="Petrichor" width="120" height="120" />

# Petrichor

**一个开箱即用的知识库与博客平台 · Next.js Web + Go API**

*A self-hostable knowledge-base and blog platform powered by Next.js and Go.*

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Go](https://img.shields.io/badge/Go-API-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com)

[产品介绍](https://wl.do/tags) · [在线 Demo](https://wl.do) · [Agent 接入](docs/agent-clients.md) · [English](#english)

</div>

## 简介

Petrichor 面向个人和小团队，集成富文本写作、多层知识库、公开博客、AI 写作与问答、站内 Assistant、对象存储上传，以及面向外部 Agent 的 REST、MCP 和 Skill 包。

系统采用清晰的前后端边界：

- `apps/web`：Next.js + React + TypeScript 客户端 SPA、SEO 薄层和 Go API 同源代理。
- `apps/api`：Gin + zap + ent + Eino 的 Go 业务后端，负责认证、数据库、AI、Agent、上传和 Feed。
- PostgreSQL：推荐 Supabase；Go 侧通过 ent 访问。
- 对象存储：任意 S3 兼容服务，本地也可使用文件目录。

## 功能

| 模块 | 能力 |
| --- | --- |
| 富文本编辑器 | PlateJS、Markdown、代码、表格、公式、白板、思维导图和媒体嵌入 |
| 知识库 | 多层目录、搜索、Wiki、分享、阅后即焚和 RSS/Atom |
| AI | 续写、改写、总结、回顾、Wiki 双链、公开问答和向量检索 |
| Assistant | 工具调用、计划、确认门闩、子代理和上下文召回 |
| 认证 | Go Cookie 会话、邮箱密码、LinuxDo OAuth；不提供 2FA |
| Agent | API Key、REST、Streamable HTTP MCP、Skill 包和调用审计 |
| 存储与公开站 | S3 预签名上传、SEO、sitemap、Feed 和主题配置 |

## 本地开发

### 前置依赖

- Node.js ≥ 22
- pnpm 10.x
- Go（版本以 `apps/api/go.mod` 为准）
- PostgreSQL（Supabase、本地或远程均可）

### 初始化

```bash
git clone https://github.com/Ciao1019/Petrichor.git petrichor
cd petrichor
pnpm install

cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local
```

在 `apps/api/.env.local` 至少填写 `DATABASE_URL`；AI 密钥加密、S3、Redis、LinuxDo 等配置也都放在这个文件。Web 侧在 `apps/web/.env.local` 设置：

```ini
PETRICHOR_GO_API_URL="http://127.0.0.1:8080"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXT_PUBLIC_REGISTER_ENABLED="false"
```

生成初始化 SQL，并在 Supabase SQL Editor 或其他 PostgreSQL 客户端中执行：

```bash
pnpm --silent --filter "@petrichor/web" db:sql > petrichor-init.sql
```

分别启动后端和前端：

```bash
pnpm dev:api
pnpm dev
```

打开 <http://localhost:3000>。Next 会把 `/api/**`、`/rss.xml`、`/atom.xml` 和 `/healthz` 代理给 Go API。

### 第一个管理员

初始化 SQL 不会创建用户。首次启动时，可暂时同时设置：

```ini
# apps/api/.env.local
PETRICHOR_REGISTER_ENABLED="true"

# apps/web/.env.local
NEXT_PUBLIC_REGISTER_ENABLED="true"
```

重启前后端后从 `/login` 注册。系统尚无超级管理员时，第一个注册账号会自动成为 `SUPER_ADMIN`。完成后把两个变量都改回 `false` 并重启。

## 环境变量

### Web

| 变量 | 说明 |
| --- | --- |
| `PETRICHOR_GO_API_URL` | Go API 地址，Web 的业务请求和 Feed 会代理到这里 |
| `NEXT_PUBLIC_APP_URL` | 对外站点 URL，用于 SEO、分享链接和 OAuth 回调 |
| `NEXT_PUBLIC_REGISTER_ENABLED` | 是否显示注册入口；需与 API 注册策略同步 |

完整模板见 [`apps/web/.env.example`](apps/web/.env.example)。

### Go API

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串，必填 |
| `APP_BASE_URL` | Web 对外地址，用于 OAuth 回调和跳转 |
| `PETRICHOR_SESSION_*` | Cookie 名和会话有效期 |
| `PETRICHOR_REGISTER_*` | 注册开关和默认角色 |
| `PETRICHOR_ENCRYPT_KEY` / `PETRICHOR_ENCRYPT_SALT` | AI 提供商密钥加解密；产生真实数据后不要更换 |
| `S3_*` / `PETRICHOR_STORAGE_DIR` | S3 兼容存储或本地存储目录 |
| `UPSTASH_REDIS_REST_*` | 可选共享缓存 |
| `PETRICHOR_LINUXDO_*` | 可选 LinuxDo OAuth |
| `PETRICHOR_PDF_INSPECTOR_URL` | PDF 解析 sidecar 地址 |

完整模板见 [`apps/api/.env.example`](apps/api/.env.example)。不要提交 `.env.local`、连接串、Cookie 或 Token。

## 部署架构

1. 把 `apps/web` 部署到 Vercel。
2. 把 `apps/api` 部署到可公开访问的 Go 运行环境，并配置 `apps/api/.env.example` 中的服务端变量。
3. 在 Vercel 设置 `PETRICHOR_GO_API_URL=https://你的-go-api`，让 Next rewrite 代理业务请求。
4. 设置真实的 `NEXT_PUBLIC_APP_URL`，并确认 Cookie 的 HTTPS、域名和 SameSite 行为符合部署拓扑。

Go API 必须可由 Vercel 访问；只部署 `apps/web` 不会提供业务接口。

## Agent 集成

Petrichor 提供 `/api/agent/**` REST 能力层、`/api/mcp` MCP 端点和可下载 Skill 包。API Key 明文只展示一次，服务端仅保存哈希，并记录外部调用审计。

- 使用指南：[`docs/agent-clients.md`](docs/agent-clients.md)
- 设计与接口说明：[`docs/agent-integration.md`](docs/agent-integration.md)
- 公开能力清单：`GET /api/agent/manifest`

## 常用命令

```bash
pnpm dev          # Next Web
pnpm dev:api      # Go API
pnpm test         # Web Vitest
pnpm test:api     # Go tests
pnpm typecheck    # TypeScript
pnpm lint         # ESLint
pnpm build        # Next production build
```

## 项目结构

```text
.
├── apps/
│   ├── web/                 # Next.js Web、SPA、SEO 与 Go API rewrite
│   └── api/                 # Go API：handlers、ent、业务域与 Eino
├── docs/
│   ├── petrichor-init.sql   # 完整初始化 SQL
│   ├── migrations/          # 历史增量迁移
│   └── agent-*.md           # Agent 接入文档
├── AGENTS.md
├── CONTRIBUTING.md
└── README.md
```

## 贡献

详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。提交前按风险运行 Web 与 Go 的相关测试，不要提交敏感配置。

## License

[Apache License 2.0](LICENSE)

## English

Petrichor is a self-hostable knowledge-base and blog platform with a **Next.js Web app** and a separate **Go API** built with Gin, ent, zap and Eino. It includes rich-text editing, hierarchical knowledge bases, AI writing and retrieval, public publishing, S3-compatible uploads, Cookie authentication, LinuxDo OAuth, and an external Agent layer with REST, MCP and downloadable Skills.

For local development, configure `apps/api/.env.local` and `apps/web/.env.local`, then run `pnpm dev:api` and `pnpm dev` in separate terminals. In production, deploy the Go API independently and point the Vercel Web app to it with `PETRICHOR_GO_API_URL`.

See the Chinese sections above for configuration, deployment and Agent integration details.
