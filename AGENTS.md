# Codex 项目级说明（petrichor / dosphere）

> 本文件适用于 `/Users/zang/dosphere` 及其子目录。它用于补充全局规则；
> 若与更深层目录的 `AGENTS.md` 冲突，优先遵循更具体的规则。

## 语言与协作

- 默认使用中文沟通、解释和记录关键决策。
- 新增代码注释和文档优先使用中文；仅在库 API、协议字段或既有英文命名要求下使用英文。
- 修改前先理解现有实现和调用链，保持变更范围小而完整。
- 不提交密钥、连接串、Cookie、Token、私有 API Key 或 `.env.local` 内容。

## 项目概览

- 仓库根目录是 `pnpm` workspace，目前工作区应用为 `apps/web`。
- 根包名为 `petrichor`，当前仓库目录名为 `dosphere`。
- `apps/web` 是 Next.js + React + TypeScript 全栈应用，目标部署环境为 Vercel。
- 前端主体是客户端 SPA：`apps/web/app/spa-entry.tsx` 动态加载
  `apps/web/src/client-app.tsx`，页面路由由 `react-router-dom` 管理。
- API 使用 Next.js App Router route handlers，`apps/web/app/api/**/route.ts` 通常只转发
  到 `apps/web/src/server/**/handlers.ts`。
- 数据层使用 Supabase PostgreSQL，Drizzle schema 位于
  `apps/web/src/server/db/schema.ts`。
- 认证使用 Better Auth + 服务端 httpOnly Cookie，业务用户与 Better Auth 用户通过
  `petrichor_user.auth_user_id` 关联。
- 上传和公开文件访问使用 S3 兼容对象存储。

## 常用命令

在仓库根目录执行：

```bash
pnpm dev
pnpm build
pnpm test
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

- `apps/web/app/`：Next.js App Router 入口、API route、RSS/Atom、SEO 元数据。
- `apps/web/src/client-app.tsx`：客户端路由总入口。
- `apps/web/src/features/pages/`：业务页面组件。
- `apps/web/src/components/`：通用组件、编辑器组件、shadcn/ui、第三方 UI 迁移组件。
- `apps/web/src/lib/`：浏览器侧工具、API client、路由工具。
- `apps/web/src/server/`：服务端 handler、业务逻辑、数据库、认证、上传等模块。
- `docs/`：初始化 SQL、增量迁移脚本和历史迁移说明。

## TypeScript 与代码风格

- 使用严格 TypeScript，优先复用现有类型和工具函数，避免引入 `any`。
- 路径别名使用 `@/*` 指向 `apps/web/src/*`。
- 缩进和格式遵循当前文件风格；服务端文件多为 4 空格，部分 shadcn/前端组件保持生成时风格。
- 业务逻辑应清晰命名、保持小函数，必要时添加中文注释说明关键流程或边界。
- 删除真正无用的旧代码；不要为了兼容已废弃实现保留平行分支。
- 不新增占位实现、TODO 或未接线的“半成品”入口。

## API 与服务端约定

- `route.ts` 尽量保持薄层，只导出对应 handler，例如：
  `export { listKnowledgeBases as POST } from "@/server/kb/handlers"`。
- handler 内统一使用 `readJson`、`ok`、`tableData`、`toErrorResponse` 等响应工具。
- 请求入参使用 `zod` 校验；ID 通常允许字符串或数字输入，服务端规范化为正整数。
- 返回给前端的数据库 bigint ID 通常序列化为字符串。
- 需要登录的接口使用 `requireCurrentUser(request)`；管理员接口需再次校验超级管理员权限。
- 列表接口沿用 `pageNum`、`pageSize`、`isAsc`、`orderByColumn` 等现有约定，
  分页解析复用 `apps/web/src/server/http/pagination.ts`。
- 前端 API client 位于 `apps/web/src/lib/api.ts`，新增接口时同步补充请求/响应类型。
- 错误响应保持 `{ code, msg, path, timestamp }` 结构，避免泄露内部错误详情。

## 数据库与迁移

- Drizzle 表结构集中在 `apps/web/src/server/db/schema.ts`，SQL 生成逻辑在
  `apps/web/src/server/db/full-migration.ts` 和相关脚本中。
- 增量数据库变更应放入 `docs/migrations/`，并在相关文档中说明执行顺序。
- Supabase transaction pooler 场景下保持 Postgres.js `prepare: false` 相关约束。
- 涉及生产数据库删除、结构变更、批量更新前必须先说明影响范围并获得明确确认。

## 前端与 UI 约定

- 优先复用 `apps/web/src/components/ui`、`shadcn-studio`、`cuicui` 和现有业务组件。
- 图标优先使用项目已有图标库，例如 `lucide-react` 或 `@tabler/icons-react`。
- 新页面应接入现有 `react-router-dom` 路由、主题、侧栏和面包屑体系。
- 表单、弹窗、下拉、Toast 等交互优先沿用现有组件和视觉风格。
- UI 改动完成后，尽量在浏览器中检查桌面和移动视口，确认没有文本溢出或组件重叠。

## 测试与验证

- 单元测试使用 Vitest，配置位于 `apps/web/vitest.config.ts`。
- 测试文件通常命名为 `*.test.ts` 或 `*.test.tsx`，放在被测模块附近。
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

- 本地环境变量样例为 `apps/web/.env.example`，实际配置写入
  `apps/web/.env.local`。
- `SESSION_SECRET`、`PETRICHOR_ENCRYPT_KEY`、`PETRICHOR_ENCRYPT_SALT` 一旦用于真实数据，
  不要随意更换。
- Vercel 生产环境建议使用 Supabase transaction pooler 连接串。
- `apps/web/README.md` 当前引用了 `docs/startup-and-config.md`，但该文件在当前工作树中不存在；
  若补充启动配置文档，优先沿用这个路径。

## Git 与安全操作

- 不要回滚用户未要求回滚的改动。
- 删除文件/目录、批量修改、数据库结构变更、`git commit`、`git push`、
  `git reset --hard` 等高风险操作前，必须先说明风险并获得明确确认。
- 提交前说明变更范围和已运行的验证命令。
