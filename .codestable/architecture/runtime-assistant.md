---
doc_type: architecture
slug: runtime-assistant
status: current
last_reviewed: 2026-07-10
implemented_by:
  - 2026-07-10-agent-runtime-core
  - 2026-07-10-agent-tools-readonly
  - 2026-07-10-agent-chat-shell
  - 2026-07-10-agent-plan-resilience
  - 2026-07-10-agent-confirm-write
  - 2026-07-10-agent-tools-admin
---

# 站内 Assistant 运行时

站内统一对话运行时（chat-first-universal-agent 的底座），代码在 `apps/web/src/server/assistant/`，路由在 `apps/web/app/api/assistant/**`。当前状态：Mastra Agent；knowledge / doc_library / system / content_write / admin 五域已就绪；壳在 `/dashboard/assistant`。

## 结构与交互

```
POST /api/assistant/chat（SSE, requireCurrentUser）
  鉴权 → zod 校验 → focus 归属校验(403) → ensureAssistantThread(404)
  → 持久化 user message → 解析模型(无配置→409) → routeAssistantIntent
  → knowledge/doc_library 补 system；admin 补 content_write（确认工具）
  → createAssistantRun →（若有确认回传）executeConfirmedDangerousAction
  → loadMastraToolsForDomains(按意图装载子集，排除 risk=dangerous)
  → Mastra Agent.stream(maxSteps=8) → toAISdkStream → SSE UIMessage 流
```

- **域工具注册表**：`risk=dangerous` 不对模型暴露，确认后 Runtime 按名执行。
- **content_write**：建文/改文/开分享 + 删文/撤分享/删文档（确认）。
- **admin**（`tools/admin.ts`）：`list_ai_configs` / `list_agent_api_keys` / `get_public_qa_setting` / `set_default_ai_config`；危险：`delete_ai_config` / `update_ai_config_credentials` / `revoke_agent_api_key` / `set_public_qa_enabled`（超管）。
- **意图路由**：规则打分；admin 辅助装载 content_write。
- **壳**：任务侧栏 + 消息内确认卡。

## 数据与状态

5 张 `petrichor_assistant_*` 表；确认态落消息 tool parts，不另建表。

## 已知约束

- 禁止一次挂载全站 tools；默认三读域不含 admin/content_write
- 公开问答开关写需超级管理员；AI 配置 / Agent Key 按 userId 归属
- 不做对话内创建 AI 配置或创建 Agent Key（留管理页）
- 禁止 `propose_wiki_patch`；不改 `/api/agent/**`
