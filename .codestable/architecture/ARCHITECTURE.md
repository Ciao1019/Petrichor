# ARCHITECTURE

> 架构中心目录总入口：只记现状，不写规划（规划见 `.codestable/roadmap/`）。
> 本骨架由 agent-runtime-core 验收时初建，仅覆盖新增子系统；存量子系统（KB / 文档库 / 认证 / 对外 Agent API 等）待 `cs-arch backfill` 补齐。

## 子系统索引

| doc | 子系统 | 一句话 |
|-----|--------|--------|
| [runtime-assistant.md](runtime-assistant.md) | 站内 Assistant 运行时 | `/api/assistant/**` 统一对话与线程持久化；按域查系统概览、检索知识库与文档库 |

## 关键架构决定

- **站内 Assistant 与对外 Agent 产品线严格分离**：站内走 `/api/assistant/**` + `petrichor_assistant_*` 表 + `src/server/assistant/`；对外集成（API Key / MCP / Skill）走 `/api/agent/**` + `petrichor_agent_*`，互不引用。
- **Assistant 运行时基于 Mastra `Agent`**（`@mastra/core` + `@mastra/ai-sdk` `toAISdkStream` 输出 AI SDK UIMessage SSE）；旧 KB QA 栈同为 Mastra，随 agent-legacy-retire 收敛到本运行时。
- **接口契约由 roadmap 锁定**：`.codestable/roadmap/chat-first-universal-agent/` 第 4 节是 assistant 相关表结构 / API / 工具注册 / 确认协议的唯一权威，改动须走 `cs-roadmap update`。
