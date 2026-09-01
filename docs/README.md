# Petrichor 文档中心

这里是 Petrichor 的技术文档入口。第一次阅读时，不必按目录逐个打开，建议先根据目标选择路径。

> 名词说明：文档中的“产品内 Wiki”是 Petrichor 从文章编译出的知识层；仓库页面顶部的
> “Wiki”是 GitHub 项目文档栏，两者相互独立。

## 从这里开始

| 你的目标 | 建议阅读 |
| --- | --- |
| 了解项目能做什么 | [根 README](../README.md) |
| 看懂文章如何变成可检索知识 | [Agentic RAG 全流程](./agent/rag.md) |
| 理解 Agent 如何规划、调用工具和收敛答案 | [Agent Runtime](./agent/runtime.md) |
| 本地配置 AI 模型 | [AI 模型配置](./ai-model-setup.md) |
| 部署和维护生产环境 | [运维手册](./operations.md) |
| 给 Claude Code / Codex / Cursor 接入 Petrichor | [外部客户端接入](./agent/clients.md) |
| 导出知识或制作 Agent Skill | [知识可移植性](./knowledge-portability.md) |

## 系统一览

```text
Browser / MCP / REST Agent
          │
          ▼
      Caddy HTTPS
     ┌────┴────┐
     ▼         ▼
Vite SPA    Go + Gin API
               ├─ PostgreSQL：用户、文章、分片、Wiki、向量、任务事实
               ├─ S3 / 本地卷：上传文件
               ├─ Redis：热点缓存
               ├─ API 内存队列：单篇知识构建
               └─ 独立 Worker：可恢复的视觉文档导入
```

生产部署只公开 Caddy。Go API 在启动监听前执行 Goose 迁移；视觉导入以 PostgreSQL 任务表为
事实来源，知识构建以 API 进程内有界队列运行。更完整的部署边界见
[运维手册](./operations.md)。

## 核心知识链路

```text
Markdown / PDF
  → 结构切片 + 推荐问题
  → 实体 / 概念 / 关系 Wiki
  → BM25 + Vector + Wiki + Outline 多路召回
  → Agent Search / Read
  → Evidence / Trace
  → 可追溯回答
```

完整算法、参数、降级路径和代码入口见
[《Petrichor Agentic RAG：从 Markdown 到可追溯回答》](./agent/rag.md)。

## 文档地图

### 知识与 RAG

- [`agent/rag.md`](./agent/rag.md)：数据进入、Markdown 切片、推荐问题、产品内 Wiki、混合召回、
  Search / Outline / Read、降级与新鲜度。
- [`knowledge-portability.md`](./knowledge-portability.md)：OKF / Obsidian 导出、知识 Skill 包、
  编译说明书与陈旧检测。
- [`ai-model-setup.md`](./ai-model-setup.md)：Chat、Embedding 等模型用途绑定和供应商配置。

### Agent Runtime 与工具

- [`agent/runtime.md`](./agent/runtime.md)：ReAct 主循环、状态、预算、证据、Trace、SSE 和安全边界。
- [`agent/tools.md`](./agent/tools.md)：工具命名空间、输入输出协议、确认票据与归一化。
- [`agent/subagents.md`](./agent/subagents.md)：复杂任务的委派和子 Agent 协作。
- [`agent/skills.md`](./agent/skills.md)：动态 Skill 加载与工具集重建。
- [`agent/debug.md`](./agent/debug.md)：Run、Trace、Evidence 和常见故障排查。

### 外部 Agent 接入

- [`agent/clients.md`](./agent/clients.md)：Claude Code、Codex、Cursor 的 MCP 和 Skill 安装步骤。
- [`agent/integration.md`](./agent/integration.md)：REST 能力层、MCP Server、API Key scope 与审计设计。

### 数据库、部署与安全

- [`database-migrations.md`](./database-migrations.md)：Goose 基线、自动迁移和首次管理员初始化。
- [`operations.md`](./operations.md)：Compose、探针、优雅关停、Worker、指标与发布检查。
- [`../SECURITY.md`](../SECURITY.md)：漏洞报告、安全部署基线与依赖审计。
- [`../apps/api/migrations/202608270002_init.sql`](../apps/api/migrations/202608270002_init.sql)：
  完整数据库初始化基线。

## 文档维护约定

- 行为和参数以当前代码、`apps/api/config.example.toml` 及数据库迁移为事实来源。
- README 保持项目级概览；算法和边界放在 `docs/`，避免在首页复制整份实现说明。
- GitHub Wiki 作为面向访客的导航和精选内容入口；`wiki/` 保存其发布源，仓库内 `docs/` 仍是完整、可评审、可版本化的事实来源。
- 修改 RAG 实现时，应同步检查切片参数、索引阶段、召回源、降级行为和代码位置是否需要更新。
