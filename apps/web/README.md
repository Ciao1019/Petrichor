# @petrichor/web

React + Vite + TypeScript 前端，包管理与 Web 运行时统一使用 **Bun 1.3.14**。业务 API 由 `apps/api` 的 Go 服务提供。

## 本地开发

在仓库根目录安装依赖并启动：

```bash
bun install
bun dev
```

Go API 单独启动：

```bash
bun run dev:api
```

## 前端环境变量

复制模板：

```bash
cp apps/web/.env.example apps/web/.env.local
```

Web 环境文件只保存 `NEXT_PUBLIC_*`、`PETRICHOR_PUBLIC_*`、`VITE_*` 和 `PETRICHOR_GO_API_URL`。数据库、Session、加密密钥、对象存储等后端配置统一写入 `apps/api/config.toml`。

## 质量检查

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```
