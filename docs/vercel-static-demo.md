![Vercel 纯前端演示站](./assets/covers/vercel-static-demo.png)

# Vercel 纯前端演示站

Petrichor 的正式生产形态仍是 Docker Compose：Web、Go API、Asynq Worker、Redis、PostgreSQL 与对象存储协同运行。
仓库根目录同时提供一个**仅用于产品展示**的 Vercel 构建目标。它复用真实 React 页面，但不会连接任何后端。

## 演示范围

- 前台知识门户、文章详情、公开 Wiki、关系图谱与全文 / 语义统一搜索；
- 静态 `/rss.xml`、`/atom.xml` 示例订阅，以及普通问答与 Wiki 问答（浏览器内脚本化流式回放）；
- 后台知识库、完整文章编辑器、Wiki 页面与图谱；
- 文档库、视觉导入任务与死信处理；
- 助手、模型配置、数据概览和全站星图；
- Agent API Key、调用日志、MCP Server 与 Agent Skill；
- 用户、关于、开源项目、外观和个人资料等管理页面。

前台示例文章来自 `apps/web/src/lib/demo/articles/`，其余演示数据位于 `apps/web/src/lib/demo/`。写操作只修改当前标签页的内存状态，刷新页面即恢复初始数据。
演示构建开启 `VITE_DEMO_ONLY=1` 后，Axios adapter 会拦截包括公开接口在内的全部站内 API；问答的 `fetch` 也会切换到本地 `ReadableStream`。因此演示站不需要 Go、数据库、Redis、S3 或模型密钥。

## 本地验证

```bash
bun install --cwd apps/web
bun run build:demo
bunx vite preview --config apps/web/vite.config.ts --outDir apps/web/dist
```

也可以直接在 `apps/web` 目录执行：

```bash
VITE_DEMO_ONLY=1 bun run dev
```

## 部署到 Vercel

根目录的 `vercel.json` 已固定：

- 安装：`bun install --cwd apps/web --frozen-lockfile`
- 构建：`bun run --cwd apps/web build:demo`
- 输出：`apps/web/dist`
- SPA fallback：所有页面路由回退到 `/index.html`

在仓库根目录执行：

```bash
bunx vercel
bunx vercel --prod
```

也可以在 Vercel 控制台导入仓库；项目 Root Directory 保持仓库根目录，让 `vercel.json` 生效即可。无需配置环境变量或密钥。

> 该部署目标不提供真实登录、持久化、AI 推理、上传、导入和后台任务。正式部署仍应使用 `compose.yaml`。
