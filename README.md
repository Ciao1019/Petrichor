<div align="center">

<img src="apps/web/public/sidebar-logo.jpg" alt="Petrichor" width="120" height="120" />

# Petrichor

**一个面向人和 AI Agent 的自托管知识平台：写作、编译 Wiki，并用 Agentic RAG 追溯答案**

*A self-hosted knowledge platform that turns Markdown into wikis, evidence and agent-ready knowledge.*

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.3-black?logo=bun)](https://bun.sh)
[![Go](https://img.shields.io/badge/Go-API-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)

[**产品介绍**](https://wl.do/tags) · [**在线 Demo**](https://wl.do) · [为什么选择 Petrichor](#为什么选择-petrichor) · [Agentic RAG](#agentic-rag-流程) · [文档](#文档导航) · [GitHub Wiki](https://github.com/Ciao1019/Petrichor/wiki)

</div>

## 为什么选择 Petrichor

- **知识不是一次性向量。** 原文分片、推荐问题、概念 Wiki 和文章目录并存，分别处理事实、用户问法、概念关系和结构性问题。
- **检索与阅读分离。** Agent 先 Search / Outline 定位，再 Read 原文形成 Evidence，避免把一批相似片段无差别塞进上下文。
- **Wiki 是可维护的知识中间层。** 整篇文档抽取实体、概念与关系，多篇文章可聚合到同一页面，并保留来源引用和新鲜度指纹。
- **知识可以交给其它 Agent。** 除 REST / MCP 外，还能导出 OKF、Obsidian 和可安装的知识 Skill 包。
- **完整自托管。** Web、API、Worker、PostgreSQL、Redis 和对象存储边界清晰，模型与数据由部署者掌握。

## 架构

```text
Browser / MCP / REST Agent
          │
          ▼
      Caddy HTTPS
     ┌────┴────┐
     ▼         ▼
Vite SPA    Go + Gin API ── PostgreSQL / S3 / Redis
                         ├─ 进程内知识构建队列
                         └─ 独立视觉导入 Worker
```

- `apps/web`：React + Vite + TypeScript 客户端 SPA；Bun 负责依赖、测试与构建，生产静态文件由 Caddy 提供。
- `apps/api`：Go + Gin API，负责数据库、认证、加密、对象存储和 Agent 能力；启动时通过 Goose 自动迁移，并以 Go 内存队列并发执行知识构建。
- `apps/api/cmd/worker`：独立常驻 Go Worker，从 PostgreSQL 持久任务表领取视觉导入任务。
- Redis 只承担热点缓存，使用 `go-redis` TCP 连接池；视觉导入队列以 PostgreSQL 为事实来源，不会因 Redis 重启丢失。
- Docker Compose 只暴露 Caddy，API、Worker 与 Redis 位于内部网络；上传支持 S3 兼容对象存储或共享本地卷。

## 功能

| 模块 | 能力 |
| --- | --- |
| 富文本编辑器 | PlateJS、Markdown、代码块、表格、公式、白板、思维导图和媒体嵌入 |
| 知识库 | 多级目录、标签、搜索、文章分享、RSS / Atom |
| Agentic RAG | 标题感知切片、问题索引、BM25 / Vector / Wiki 融合、目录导航、Evidence / Trace |
| 产品内 Wiki | 整篇抽取实体、概念与关系，多文章聚合、知识图谱、来源引用和结构检查 |
| 知识可移植 | OKF / Obsidian 导出、Agent Skill 包蒸馏、知识库级编译说明书、陈旧检测 |
| AI 助手 | ReAct 工具循环、计划、子 Agent、动态 Skill、站内问答与外部研究 |
| 认证 | Sa-Token-Go、邮箱密码、httpOnly Cookie、LinuxDo OAuth、会话管理 |
| 对象存储 | S3 兼容上传和预签名 URL |
| Agent 集成 | API Key、MCP、可下载 Skill 包、REST 能力和调用审计 |

## Agentic RAG 流程

```text
Markdown / PDF
  → 按标题结构切片 + 每片 3 个推荐问题
  → 整篇抽取实体 / 概念 / 关系，编译产品内 Wiki
  → 原文 Vector/BM25 + 问题 Vector/BM25 + Wiki 多路召回
  → RRF 融合 + 文章级平衡 + 本地重排 + 多样性过滤
  → Agent Search / Outline → Read → Evidence → Answer
```

这里没有把“检索结果”直接当答案：`knowledge.search` 只返回轻量定位信息，Agent 根据任务选择
`knowledge.read` / `read_many` 深读；推荐问题命中后也必须回到原始分片。结构性问题则使用
`knowledge.outline` 浏览 PageIndex 或分片标题目录，避免相似度检索打散章节顺序。

完整的切片参数、Wiki 构建、索引结构、召回算法、降级策略和代码入口见
[《Petrichor Agentic RAG：从 Markdown 到可追溯回答》](docs/agent/rag.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [文档中心](docs/README.md) | 按使用目标组织的完整索引与系统概览 |
| [Agentic RAG](docs/agent/rag.md) | 数据进入、结构切片、Wiki 编译、混合召回与 Agent 深读 |
| [Agent Runtime](docs/agent/runtime.md) | ReAct、状态、预算、Evidence、Trace、SSE 与安全边界 |
| [AI 模型配置](docs/ai-model-setup.md) | 供应商、用途绑定、协议和向量维度 |
| [外部客户端接入](docs/agent/clients.md) | Claude Code、Codex、Cursor 的 MCP / Skill 配置 |
| [知识可移植性](docs/knowledge-portability.md) | OKF、Obsidian、知识 Skill 包、编译说明书和新鲜度 |
| [运维手册](docs/operations.md) | Compose、探针、Worker、指标和发布检查 |

精选指南也会发布到 [GitHub Wiki](https://github.com/Ciao1019/Petrichor/wiki)；仓库内 `docs/`
仍是可评审、可版本化的文档事实来源。

## 本地开发

前置要求：Bun 1.3.14+、Go（版本以 `apps/api/go.mod` 为准）、Docker 和 PostgreSQL。

```bash
bun install --cwd apps/web
cp apps/web/.env.example apps/web/.env.local
cp apps/api/config.example.toml apps/api/config.toml
```

本机热更新开发时，先只启动 Compose 内的 Redis，并把 `config.toml` 的
`cache.redis.url` 改为 `redis://127.0.0.1:6379/0`。Redis 端口仅绑定回环地址，不会暴露到公网：

```bash
docker compose up -d redis

# 终端 1：默认 http://127.0.0.1:8080，启动前自动执行数据库迁移
cd apps/api && go run ./cmd/server

# 终端 2：常驻视觉导入任务
cd apps/api && go run ./cmd/worker

# 终端 3：默认 http://127.0.0.1:3000
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

## Docker Compose 部署

服务器需要 Docker Engine 与 Compose v2。复制配置后，至少设置生产域名、PostgreSQL、
加密参数、对象存储和模型凭证：

```bash
cp .env.example .env
cp apps/api/config.example.toml apps/api/config.toml
```

生产配置的关键值：

```toml
[server]
environment = "production"
base_url = "https://example.com"
trusted_proxies = ["172.30.0.0/24"]

[cache.redis]
url = "redis://redis:6379/0"

[storage]
local_directory = "/data/uploads"
```

在 `.env` 中把 `PETRICHOR_DOMAIN` 改为已解析到服务器的域名，然后启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api worker
```

Caddy 自动申请和续签 HTTPS 证书，并把 `/api/*`、`/healthz`、`/readyz` 转发给内部 Go API；
其余请求直接提供 Vite 静态资源。Redis 仅在 Compose 内网可访问，宿主机端口也只绑定
`127.0.0.1`。`config.toml` 通过 Compose secret 挂载，构建时不会进入镜像。

API 与 Worker 使用同一个 Go 镜像但独立运行：API 处理请求、迁移和进程内知识构建队列，
Worker 只常驻领取 PostgreSQL 视觉导入任务。知识构建中间状态不入库；API 容器重启时，排队或
执行中的知识构建需要用户重新发起，已经提交的切片、Wiki 页面和向量不受影响。更新时使用
`docker compose up -d --build`；查看迁移状态使用：

```bash
docker compose run --rm api migrate status
```

若只需本机 HTTP，把 `PETRICHOR_DOMAIN` 保持为 `:80`。生产服务器需放行 TCP 80/443 和
UDP 443；不要向公网开放 8080 或 6379。若服务器无法访问官方 Go 模块代理，可在 `.env` 中把
`PETRICHOR_GOPROXY` 改为可信的镜像地址。

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
| `[cache.redis]` | 本地/自托管 Redis URL、TCP 连接池和命令超时 |
| `[agent.features]` | Agent Runtime 功能开关 |
| `[agent.budget]` | 迭代、工具调用、超时、重试和上下文预算 |
| `[agent.research]` | 可选外部搜索供应商与超时 |

`config.toml` 包含数据库连接串和密钥，已被 Git 与 Docker 忽略。不要提交或输出真实内容；
`encryption.key` 和 `encryption.salt` 一旦用于真实数据，不要随意更换。生产环境会拒绝模板/弱加密值；
`server.trusted_proxies` 只能配置真实入口代理，数据库连接池 `max_conns` 至少为 6。

### Web 前端

[`apps/web/.env.example`](apps/web/.env.example) 只包含 Web 所需配置：

- `PETRICHOR_PUBLIC_*`、`VITE_*`：浏览器可见的公开配置。
- `PETRICHOR_GO_API_URL`：仅供本地 Bun Web 代理使用，不会作为 Vite 客户端变量暴露。

生产镜像由 Caddy 直接提供构建产物，不运行 Bun Server。数据库、Session、加密、S3、
LinuxDo、Redis 和 Agent 配置不得写入 Web 环境文件。

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
cd apps/api && go run ./cmd/worker  # 启动常驻视觉导入 Worker
cd apps/api && go run ./cmd/migrate status  # 查看 Goose 状态
docker compose up -d --build        # 构建并启动生产服务栈
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
│   │   │   ├── worker/            # 常驻视觉导入 Worker 入口
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
│       ├── server.ts              # 本地 Bun 静态服务与 Go 反代
│       ├── Caddyfile              # 生产静态服务与 API 反代
│       ├── patches/               # Web 依赖补丁
│       ├── bun.lock               # Web 依赖锁文件
│       └── .env.example           # 仅 Web 配置
├── docs/
│   ├── agent/                     # Agent、RAG 与接入文档
│   └── database-migrations.md     # Goose 迁移说明
├── wiki/                          # GitHub Wiki 的 Home、侧栏与精选页面发布源
├── compose.yaml                   # Caddy、Go API、Go Worker 与 Redis
├── package.json                   # 根命令入口，不承载 Web 依赖
├── AGENTS.md                      # 项目协作规范
└── CONTRIBUTING.md                # 贡献流程
```

根目录不安装 Node 依赖，也不保存前后端源码；`package.json` 只把常用命令转发到对应应用。
`wiki/` 保存 GitHub Wiki 独立仓库的发布源，仓库内 `docs/` 仍是完整技术文档的事实来源。
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
