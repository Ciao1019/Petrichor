# Codex 项目级说明（petrichor / dosphere）

> 本文件适用于当前 Petrichor 仓库及其子目录。它用于补充全局规则；
> 若与更深层目录的 `AGENTS.md` 冲突，优先遵循更具体的规则。

## 语言与协作

- 默认使用中文沟通、解释和记录关键决策。
- 新增代码注释和文档优先使用中文；仅在库 API、协议字段或既有英文命名要求下使用英文。
- 修改前先理解现有实现和调用链，保持变更范围小而完整。
- 不提交密钥、连接串、Cookie、Token、私有 API Key 或 `.env.local` 内容。

## 项目概览

- 仓库根目录提供统一命令；`apps/web` 是独立 Bun package，依赖、锁文件和补丁均保存在
  Web 目录；`apps/api` 是独立 Go module。
- `apps/web` 是 Bun + React + Vite + TypeScript 客户端 SPA，入口为
  `apps/web/src/main.tsx`，页面路由由 `react-router-dom` 管理。
- `apps/api` 是 Go + Gin API 服务，接管 `/api/*` 和 `/healthz`。
- 生产环境由 `apps/web/Caddyfile` 托管 Vite 静态资源并反代 Go API；`apps/web/server.ts` 仅用于本地 Bun 运行。
- 数据层使用启用 `pg_trgm` 与 `vector` 扩展的 PostgreSQL 16+，完整结构由
  `apps/api/migrations/202608270002_init.sql` 定义，并由 Go 服务启动时自动执行。
- 认证使用 Sa-Token-Go 的 Gin 集成，token 状态由 `sa_token_storage` 持久化到 PostgreSQL；
  业务用户只保存在 `petrichor_user`。
- 上传和公开文件访问使用 S3 兼容对象存储。
- 生产部署统一使用根目录 `compose.yaml`：Caddy、Go API、独立视觉导入 Worker 与本地 Redis；Redis 使用 `go-redis/v9`。知识构建由 API 内存队列执行，视觉导入任务以 PostgreSQL 为事实来源。

## 常用命令

在仓库根目录执行：

```bash
bun install --cwd apps/web
bun dev
cd apps/api && go run ./cmd/server
bun run build
bun run test
bun run typecheck
bun run lint
docker compose up -d --build
```

只针对 Web 应用执行时使用：

```bash
bun run --cwd apps/web dev
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
```

查看数据库迁移状态使用纯 Go 命令：

```bash
cd apps/api && go run ./cmd/migrate status
```

## 目录约定

- `apps/api/cmd/server/`：Go API 生产入口。
- `apps/api/cmd/migrate/`：Goose 数据库迁移命令入口。
- `apps/api/cmd/worker/`：视觉文档导入常驻 Worker 入口；知识构建 Worker 位于 API 进程内。
- `apps/api/internal/`：Go 鉴权、业务、数据库、存储、缓存和 Agent 实现。
- `apps/api/migrations/`：随 Go 二进制内嵌的 Goose 初始化 SQL。
- `apps/api/config.example.toml`：Go 运行配置模板；本地真实配置为忽略提交的 `config.toml`。
- `apps/web/src/main.tsx`：Vite 客户端入口。
- `apps/web/server.ts`：本地 Bun Web 静态服务与 Go API 同源反代入口。
- `apps/web/Caddyfile`：生产静态资源服务、压缩、缓存与 Go API 同源反代。
- `apps/web/src/client-app.tsx`：客户端路由总入口。
- `apps/web/src/features/pages/`：业务页面组件。
- `apps/web/src/components/`：通用组件、编辑器组件、shadcn/ui、第三方 UI 迁移组件。
- `apps/web/src/lib/`：浏览器侧工具、API client、路由工具。
- `apps/web/bun.lock`、`apps/web/patches/`：Web 依赖锁文件与本地依赖补丁。
- `docs/`：数据库、Agent、模型配置和设计说明。

## TypeScript 与代码风格

- 使用严格 TypeScript，优先复用现有类型和工具函数，避免引入 `any`。
- 路径别名使用 `@/*` 指向 `apps/web/src/*`。
- 缩进和格式遵循当前文件风格；Go 使用 `gofmt`，部分 shadcn/前端组件保持生成时风格。
- 业务逻辑应清晰命名、保持小函数，必要时添加中文注释说明关键流程或边界。
- 删除真正无用的旧代码；不要为了兼容已废弃实现保留平行分支。
- 不新增占位实现、TODO 或未接线的“半成品”入口。
- 单个源文件不超过 800 行，由 `scripts/check-file-size.sh` 在 CI 强制。
  历史超长文件记在 `scripts/file-size-baseline.txt`，只能变小不能变大；
  生成式 UI 组件（`components/ui`、`extend`、`assistant-ui`、`tool-ui`）不参与检查。

## API 与服务端约定

- Go 路由在 `apps/api/internal/routes` 注册，业务实现按领域放在 `internal/*svc` 或对应模块。
- ID 通常允许字符串或数字输入，服务端规范化为正整数。
- 返回给前端的数据库 bigint ID 通常序列化为字符串。
- 需要登录的接口复用 Go 鉴权中间件；管理员接口需再次校验超级管理员权限。
- 列表接口沿用 `pageNum`、`pageSize`、`isAsc`、`orderByColumn` 等现有约定，
  并复用 Go HTTP 契约工具。
- 前端 API client 位于 `apps/web/src/lib/api.ts`，新增接口时同步补充请求/响应类型。
- Wiki 页面、链接、来源引用、补丁和审计事件的写操作统一走
  `apps/api/internal/kb/wikimutation.go` 的入口，不要在业务文件里直接拼这些表的写 SQL。
- 错误响应保持 `{ code, msg, path, timestamp }` 结构，避免泄露内部错误详情。

## 数据库与迁移

- 完整数据库基线为 `apps/api/migrations/202608270002_init.sql`，后续变更使用更高版本迁移。
- Go API 在监听端口前自动执行 Goose；迁移失败时服务不得继续启动，数据库流程与 Bun 无关。
- 后续数据库变更放入 `apps/api/migrations/`，使用更高的纯数字版本前缀并添加
  `-- +goose Up`；已执行文件不可修改，应新增后续迁移。
- Goose 使用 `goose_db_version` 管理版本，并以 PostgreSQL 表租约锁避免并发迁移。
- 经 transaction pooler 连接 PostgreSQL 时保持 pgx `QueryExecModeExec`，不要启用
  prepared statement 缓存。
- 涉及生产数据库删除、结构变更、批量更新前必须先说明影响范围并获得明确确认。

## 前端与 UI 约定

- 优先复用 `apps/web/src/components/ui`、`petrichor-ui`、`cuicui` 和现有业务组件。
- 图标统一从 `@/components/iconimate` 引入；不要重新添加独立图标运行时依赖。
- 新页面应接入现有 `react-router-dom` 路由、主题、侧栏和面包屑体系。
- 表单、弹窗、下拉、Toast 等交互优先沿用现有组件和视觉风格。
- UI 改动完成后，尽量在浏览器中检查桌面和移动视口，确认没有文本溢出或组件重叠。

## 测试与验证

- 单元测试使用 Vitest，配置位于 `apps/web/vitest.config.ts`。
- 测试文件通常命名为 `*.test.ts` 或 `*.test.tsx`，放在被测模块附近。
- 优先运行与改动相关的定向测试；完整验证按风险选择：

```bash
bun run test
bun run typecheck
bun run lint
bun run build
./scripts/check-file-size.sh
cd apps/api && go test ./... && go vet ./...
```

- 需要真实数据库的只读集成测试默认跳过，按需用环境变量开启：
  `PETRICHOR_WIKI_EXPORT_LIVE_TEST=1`（Wiki 导出与 Skill 包）、
  `PETRICHOR_OUTLINE_LIVE_TEST=1`（文档目录）、
  `PETRICHOR_RECALL_LIVE_TEST=1`（检索召回）。它们只读，但会连本机 `config.toml` 的库。
- 后台执行单元测试时注意控制时长，避免超过 60 秒卡住当前任务。
- 若未能运行某项验证，需要在交付说明中明确原因和剩余风险。

## 环境与部署

- Web 公开配置样例为 `apps/web/.env.example`，实际配置写入 `apps/web/.env.local`。
- Go 不读取环境变量；数据库、Session、加密、S3、LinuxDo、Redis 和 Agent 配置统一写入
  `apps/api/config.toml`，模板为 `apps/api/config.example.toml`。
- `config.toml` 含密钥且已忽略提交，不得输出或提交其真实内容。
- `encryption.key`、`encryption.salt` 一旦用于真实数据，不要随意更换。
- 生产环境可使用自建或托管 PostgreSQL；通过 transaction pooler 接入时，应分别验证
  `[database].url` 与可选的迁移连接。

## Git 与安全操作

- 不要回滚用户未要求回滚的改动。
- 删除文件/目录、批量修改、数据库结构变更、`git commit`、`git push`、
  `git reset --hard` 等高风险操作前，必须先说明风险并获得明确确认。
- 提交前说明变更范围和已运行的验证命令。
