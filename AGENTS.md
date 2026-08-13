# Codex 项目级说明（petrichor / dosphere）

> 本文件适用于 `/Users/zang/dosphere` 及其子目录。它用于补充全局规则；
> 若与更深层目录的 `AGENTS.md` 冲突，优先遵循更具体的规则。

## 语言与协作

- 默认使用中文沟通、解释和记录关键决策。
- 新增代码注释和文档优先使用中文；仅在库 API、协议字段或既有英文命名要求下使用英文。
- 修改前先理解现有实现和调用链，保持变更范围小而完整。
- 不提交密钥、连接串、Cookie、Token、私有 API Key 或 `.env.local` 内容。

## 项目概览

- 仓库根目录是 `pnpm` workspace，目前工作区应用为 `apps/web` + `apps/api`。
- 根包名为 `petrichor`。
- `apps/web` 是 Next.js + React + TypeScript 前端（SPA），目标部署环境为 Vercel。
- `apps/api` 是 Go 后端（Gin + zap + ent + Eino），已替换原 `apps/web/src/server/**`；认证无 2FA。
- **本地/生产必须设置 `PETRICHOR_GO_API_URL`**（如 `http://127.0.0.1:8080`），Next 通过 rewrites 把 `/api/*`、`/rss.xml`、`/atom.xml`、`/healthz` 代理到 Go。可用 `pnpm dev:api` 启动 API。
- 前端主体是客户端 SPA：`apps/web/app/spa-entry.tsx` 动态加载
  `apps/web/src/client-app.tsx`，页面路由由 `react-router-dom` 管理。
- 数据层使用 Supabase PostgreSQL；Go 侧用 ent schema 映射表。初始化 SQL 生成脚本在 `apps/web/scripts/db/full-migration.ts`。
- 认证使用 Go `petrichor_auth_session` Cookie 会话（无 TOTP）。
- 上传和公开文件访问使用 S3 兼容对象存储。

## 常用命令

在仓库根目录执行：

```bash
pnpm dev
pnpm dev:api
pnpm build
pnpm test
pnpm test:api
pnpm typecheck
pnpm lint
```

只针对 Web 应用执行时使用：

```bash
pnpm --filter "@petrichor/web" dev
pnpm --filter "@petrichor/web" test
pnpm --filter "@petrichor/web" typecheck
pnpm --filter "@petrichor/web" lint
pnpm --filter "@petrichor/web" build
```

生成初始化 SQL 时必须使用 `--silent`，避免 pnpm 日志混入 SQL：

```bash
pnpm --silent --filter "@petrichor/web" db:sql
```

## 目录约定

- `apps/web/app/`：Next.js App Router 入口、SEO 元数据（sitemap/robots）；业务 API 已迁至 Go。
- `apps/web/src/client-app.tsx`：客户端路由总入口。
- `apps/web/src/features/pages/`：业务页面组件。
- `apps/web/src/components/`：通用组件、编辑器组件、shadcn/ui、第三方 UI 迁移组件。
- `apps/web/src/lib/`：浏览器侧工具、API client、公开站元数据、路由工具。
- `apps/api/`：Go API（handlers、ent、业务域）。
- `docs/`：初始化 SQL、增量迁移脚本和历史迁移说明。

## TypeScript 与代码风格

- 使用严格 TypeScript，优先复用现有类型和工具函数，避免引入 `any`。
- 路径别名使用 `@/*` 指向 `apps/web/src/*`。
- 缩进和格式遵循当前文件风格；部分 shadcn/前端组件保持生成时风格。
- 业务逻辑应清晰命名、保持小函数，必要时添加中文注释说明关键流程或边界。
- 删除真正无用的旧代码；不要为了兼容已废弃实现保留平行分支。
- 不新增占位实现、TODO 或未接线的“半成品”入口。

## API 约定

- 业务 API 实现在 `apps/api`；前端通过同源 `/api/**`（由 Next rewrite 到 Go）调用。
- 返回给前端的数据库 bigint ID 通常序列化为字符串。
- 列表接口沿用 `pageNum`、`pageSize`、`isAsc`、`orderByColumn` 等约定。
- 前端 API client 位于 `apps/web/src/lib/api.ts`，新增接口时同步补充请求/响应类型。
- 错误响应保持 `{ code, msg, path, timestamp }` 结构，避免泄露内部错误详情。

## 数据库与迁移

- 初始化 SQL 生成：`apps/web/scripts/db/full-migration.ts`。
- 表结构以 Go ent schema（`apps/api/ent/schema`）与 `docs/` 迁移为准。
- 增量数据库变更应放入 `docs/migrations/`，并在相关文档中说明执行顺序。
- 涉及生产数据库删除、结构变更、批量更新前必须先说明影响范围并获得明确确认。

## 前端与 UI 约定

- 优先复用 `apps/web/src/components/ui`、`petrichor-ui`、`cuicui` 和现有业务组件。
- 图标优先使用项目已有图标库，例如 `lucide-react` 或 `@tabler/icons-react`。
- 新页面应接入现有 `react-router-dom` 路由、主题、侧栏和面包屑体系。
- 表单、弹窗、下拉、Toast 等交互优先沿用现有组件和视觉风格。
- UI 改动完成后，尽量在浏览器中检查桌面和移动视口，确认没有文本溢出或组件重叠。

## 测试与验证

- 单元测试使用 Vitest，配置位于 `apps/web/vitest.config.ts`。
- Go 测试：`pnpm test:api` 或 `cd apps/api && go test ./...`。
- 优先运行与改动相关的定向测试；完整验证按风险选择：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

- 后台执行单元测试时注意控制时长，避免超过 60 秒卡住当前任务。
- 若未能运行某项验证，需要在交付说明中明确原因和剩余风险。

## 环境与部署

- Web 环境变量样例为 `apps/web/.env.example`，实际配置写入 `apps/api/.env.local`。
- Go 环境变量样例为 `apps/api/.env.example`。
- Web 侧必须配置 `PETRICHOR_GO_API_URL` 才能访问业务 API。
- `PETRICHOR_ENCRYPT_KEY`、`PETRICHOR_ENCRYPT_SALT` 一旦用于真实数据，不要随意更换。
- Vercel 生产环境：前端部署在 Vercel，API 部署到可访问的 Go 服务，并配置 rewrite 目标 URL。

## Git 与安全操作

- 不要回滚用户未要求回滚的改动。
- 删除文件/目录、批量修改、数据库结构变更、`git commit`、`git push`、
  `git reset --hard` 等高风险操作前，必须先说明风险并获得明确确认。
- 提交前说明变更范围和已运行的验证命令。
