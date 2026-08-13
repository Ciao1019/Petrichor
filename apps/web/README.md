# @petrichor/web

Petrichor 的 Next.js + React + TypeScript Web 应用。它负责客户端 SPA、SEO 页面和静态资源；业务 API、认证、数据库访问、AI、Feed 与上传逻辑都由 `apps/api` 的 Go 服务提供。

## 本地开发

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
```

Web 环境变量：

```ini
PETRICHOR_GO_API_URL="http://127.0.0.1:8080"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXT_PUBLIC_REGISTER_ENABLED="false"
```

先在另一个终端启动 Go API，再启动 Web：

```bash
pnpm dev:api
pnpm --filter "@petrichor/web" dev
```

Next rewrite 会把 `/api/**`、Feed 和 `/healthz` 代理到 `PETRICHOR_GO_API_URL`。

## 数据库工具

Web 工作区仍保留纯 SQL 生成与显式 SQL 执行工具，它们只用于开发和迁移，不属于线上 TypeScript 后端：

```bash
pnpm --silent --filter "@petrichor/web" db:sql > petrichor-init.sql
pnpm --filter "@petrichor/web" db:run-sql -- path/to/migration.sql
```

数据库结构以 `apps/api/ent/schema` 和 `docs/migrations` 为准。

## 验证

```bash
pnpm --filter "@petrichor/web" test
pnpm --filter "@petrichor/web" typecheck
pnpm --filter "@petrichor/web" lint
pnpm --filter "@petrichor/web" build
```
