---
doc_type: architecture
slug: runtime-assistant
status: current
last_reviewed: 2026-07-16
implemented_by:
  - 2026-07-10-agent-runtime-core
  - 2026-07-10-agent-tools-readonly
  - 2026-07-10-agent-chat-shell
  - 2026-07-10-agent-plan-resilience
  - 2026-07-10-agent-confirm-write
  - 2026-07-10-agent-tools-admin
  - 2026-07-10-agent-context-compress
  - 2026-07-10-agent-subagents
  - 2026-07-10-agent-plan-persist
  - 2026-07-10-agent-context-window-v2
  - 2026-07-10-agent-resilience-playbook
  - 2026-07-10-agent-context-vector-recall
  - 2026-07-10-agent-subagent-depth-limit
  - 2026-07-10-agent-subagent-write
  - 2026-07-10-agent-multi-agent-fanout
---

# 站内 Assistant 运行时

站内统一对话运行时（chat-first-universal-agent 的底座），代码在 `apps/web/src/server/assistant/`，路由在 `apps/web/app/api/assistant/**`。当前状态：Mastra Agent；knowledge / doc_library / system / content_write / admin 五域已就绪；壳在 `/dashboard/assistant`；长对话支持语义上下文压缩。

## 结构与交互

```
POST /api/assistant/chat（SSE, requireCurrentUser）
  鉴权 → zod 校验 → focus 归属校验(403) → ensureAssistantThread(404)
  → 持久化 user message → 解析模型(无配置→409) → routeAssistantIntent
  → 意图路由（芯片/skills 加权）；resolveToolLoadDomains：核心域常驻（含 content_write），admin 按需
  → createAssistantRun →（若有确认回传）executeConfirmedDangerousAction
  → 开 SSE：可选 data-context-compress(running) → buildContextPack（摘要/窗口）
  → loadMastraToolsForDomains(toolDomains) → Mastra Agent.stream(maxSteps=8) → toAISdkStream
```

- **域工具注册表**：`risk=dangerous` 不对模型暴露，确认后 Runtime 按名执行。
- **content_write**：建文/改文/开分享/移文（含跨库）+ 删文/撤分享/删文档（确认）。**会话常驻装载**（对齐 Claude Code：小工具集不靠意图硬门控藏工具）。
- **admin**（`tools/admin.ts`）：`list_ai_configs` / `list_agent_api_keys` / `get_public_qa_setting` / `set_default_ai_config`；危险：`delete_ai_config` / `update_ai_config_credentials` / `revoke_agent_api_key` / `set_public_qa_enabled`（超管）。仍按意图按需装载。
- **上下文压缩**（`context-pack.ts`）：线程级 `context_summary_*`；动态最近窗口 `windowPolicy`（下限 6、上限 20，按 token 预算扩张）；可选向量历史召回 `recalledSnippets`（无 EMBEDDING/SQLite 跳过）；`TokenLimiterProcessor` 硬裁剪兜底；壳展示「正在整理对话上下文…」。
- **子代理**（`tools/research-subagent.ts` / `write-subagent.ts` / `research-fanout.ts`）：只读 `spawn_research_subagent`（depth/maxDepth）；并行 `spawn_research_fanout`（≤3，工人 maxDepth=0）；写意图 `spawn_write_subagent`（提案回主对话确认）；无团队 DSL。
- **意图路由**：规则/LLM 主要用于芯片展示与 admin 触发；**不再作为 content_write 工具开关**。写域粘性/保底仍保留作防御。
- **壳**：任务侧栏 + 消息内确认卡。
- **韧性 Playbook**（`tool-resilience.ts`）：超时 30s；失败 soft-return `tool_degraded` / 熔断 `tool_circuit_open` 与换招文案；不自动代执行其他工具。

## 数据与状态

6 张 `petrichor_assistant_*` 表（含 plan）+ `petrichor_assistant_message_embedding`（pgvector）；thread 含上下文摘要三列；确认态落消息 tool parts。`upsert_plan` 落库后 `thread/detail` 返回 `plans[]`，侧栏 live 优先、无 live 时冷启动未完成 Plan。

## 已知约束

- 核心会话域常驻：`system` + `knowledge` + `doc_library` + `content_write`；`admin` 按需；dangerous 仍不对模型暴露
- 公开问答开关写需超级管理员；AI 配置 / Agent Key 按 userId 归属
- 不做对话内创建 AI 配置或创建 Agent Key（留管理页）
- 禁止 `propose_wiki_patch`；不改 `/api/agent/**`
- 压缩无独立 HTTP API；摘要失败不阻断对话
