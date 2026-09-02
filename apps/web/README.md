# @petrichor/web

React + Vite + TypeScript 前端，包管理与 Web 运行时统一使用 **Bun 1.3.14**。业务 API 由 `apps/api` 的 Go 服务提供。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/main.tsx` | 浏览器入口 |
| `src/client-app.tsx` | 路由、布局和页面懒加载入口 |
| `src/features` | 按业务领域组织的页面和功能 |
| `src/components` | 通用组件、编辑器和 UI 组件 |
| `src/hooks` | 浏览器侧复用 Hooks |
| `src/lib` | API client、路由和通用工具 |
| `src/styles` | 全局与专题样式 |
| `public` | 不经过打包处理的静态资源 |
| `scripts` | Web 开发和代码生成脚本 |
| `server.ts` | 本地静态服务与 Go API 同源反代 |
| `patches` | 仅属于 Web 依赖的 Bun 补丁 |

## 本地开发

在仓库根目录安装依赖并启动：

```bash
bun install --cwd apps/web
bun dev
```

Go API 单独启动：

```bash
cd apps/api && go run ./cmd/server
```

## 前端环境变量

复制模板：

```bash
cp apps/web/.env.example apps/web/.env.local
```

Web 环境文件只保存 `PETRICHOR_PUBLIC_*`、`VITE_*` 和 `PETRICHOR_GO_API_URL`。数据库、Session、加密密钥、对象存储等后端配置统一写入 `apps/api/config.toml`。

## Docker 镜像

公开镜像 [`ghcr.io/ciao1019/petrichor-web`](https://github.com/users/Ciao1019/packages/container/package/petrichor-web)
使用 Caddy 提供 Vite 静态产物，并支持 `linux/amd64` 与 `linux/arm64`：

```bash
docker pull ghcr.io/ciao1019/petrichor-web:latest
```

`latest` 与 `master` 指向当前发布版本，`sha-<12 位提交哈希>` 用于不可变部署。Caddyfile 会把
`/api/*` 与 `/healthz` 反代到同一 Docker 网络中的 `api:8080`，完整部署请使用仓库根目录的
`compose.yaml`。

## 质量检查

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```
