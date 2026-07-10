---
doc_type: architecture
slug: runtime-assistant
status: current
last_reviewed: 2026-07-10
implemented_by:
  - 2026-07-10-agent-runtime-core
  - 2026-07-10-agent-tools-readonly
---

# 站内 Assistant 运行时

站内统一对话运行时（chat-first-universal-agent 的底座），代码在 `apps/web/src/server/assistant/`，路由在 `apps/web/app/api/assistant/**`。当前状态：Mastra Agent 运行时与 knowledge / doc_library / system 三域共 12 个工具已就绪；Chat-first 壳在 `/dashboard/assistant`。

## 结构与交互

```
POST /api/assistant/chat（SSE, requireCurrentUser）
  鉴权 → zod 校验 → focus 归属校验(403) → ensureAssistantThread(404)
  → 持久化 user message → 解析模型(无配置→409) → routeAssistantIntent
  → knowledge/doc_library 命中时在路由器内补 system 辅助域
  → createAssistantRun → loadMastraToolsForDomains(按意图装载子集)
  → Mastra Agent.stream(maxSteps=8) → toAISdkStream → SSE UIMessage 流
  回调：afterToolCall→recordAssistantStep；onFinish/onError→finish run
```

- **运行时栈**：`@mastra/core` `Agent` + `@mastra/ai-sdk` `toAISdkStream`（v6）；生产环境挂 PromptInjectionDetector + TokenLimiterProcessor。
- **域工具注册表**（`tool-registry.ts`）：`registerAssistantTools` / `loadMastraToolsForDomains(domains, ctx)` → Mastra `createTool` 集合；`loadToolsForDomains` 保留 AI SDK `ToolSet` 形态供单测。`chat-handler.ts` side-effect import `tools/index.ts`，模块加载时完成三域注册。
- **knowledge 域**（`tools/knowledge.ts`）：`list_knowledge_bases`、`search_knowledge`、`read_knowledge_node`。有库范围时组合目录树关键词/推理检索与语义检索，无范围时跨库检索；统一支持 `nodeKey | pageKey | articleId` 三选一读取。
- **doc_library 域**（`tools/doc-library.ts`）：`list_doc_libraries`、`search_documents`、`read_document`。支持 library/document/focus 限定，读取通过 `fromIndex` 与 `limit` 翻页。
- **system 域**（`tools/system.ts`）：`list_system_overview`、`show_progress`、`show_citations`、`show_data_table`、`save_answer_artifact`、`upsert_plan`。仅 `save_answer_artifact` 为 `risk=write`；其余为 `read`，其中 UI 工具只校验并回显现有组件 schema，`upsert_plan` 不持久化。
- **意图路由**（`intent-router.ts`）：`routeAssistantIntent({ userText, focus, recentToolNames })` → `{ domains, confidence, rationale }`；规则打分实现，无信号默认 `["system","knowledge","doc_library"]`；命中 knowledge/doc_library 时集中补入 system，纯 system 不反向扩域。实现可换、形状由 roadmap 4.2 锁定。
- **域感知提示**（`chat-handler.ts`）：按本轮 `route.domains` 注入检索→阅读→引用纪律；站内事实必须来自工具结果，检索不到时不得编造。
- 域枚举 `AgentDomainId`：`knowledge | doc_library | system | content_write | admin`

## 数据与状态

5 张表（`schema.ts` + `full-migration.ts`，契约 roadmap 4.5）：

- `petrichor_assistant_thread`：user_id / title / focus_json / **deleted_at（软删）**
- `petrichor_assistant_message`：thread_id / role / content_json（完整 UIMessage parts，供回放）
- `petrichor_assistant_run`：status（RUNNING/COMPLETED/FAILED）/ model_config_id / intent_domains_json / error_code；`intent_domains_json` 与本轮工具装载直接使用同一份 `route.domains`
- `petrichor_assistant_step`：run_id / step_index / tool_name / input_json / output_json / duration_ms；工具成功/失败分别落 `COMPLETED` / `FAILED`
- `petrichor_assistant_artifact`：`save_answer_artifact` 写入 kind/title/content_json，并关联当前 thread_id/run_id；暂无读取或前端展示入口

与旧 `petrichor_kb_agent_*` / `petrichor_doc_qa_*` 完全独立，不迁移旧数据。

## 已知约束

- **每轮先意图路由再装载工具子集，禁止一次挂载全站 tools**（roadmap 4.1）；knowledge/doc_library 只辅助加入 system，不因此加入 content_write/admin
- 工具包装继续调用既有 userId 归属查询；focus 只提供默认范围，显式范围仍由底层函数校验所有权
- `search_knowledge` 的语义支路不可用（SQLite、无 EMBEDDING 配置或服务错误）时静默保留关键词结果，并以 `mode` 标出降级；不得让整次工具调用失败
- 控制上下文体积：知识树检索片段 `maxContentChars=1600`，知识检索 `limit<=12`，文档检索 `limit<=20`，`read_document` 单次 `limit<=40` chunk
- 工具内部错误记录 FAILED step，但不把 run 直接判失败；模型仍可改用其他工具或继续给出降级回答
- 流开始前的错误走非流 JSON `{ code, msg, path, timestamp }`（401/400/403/404/409=model_not_configured）；流开始后只标记 run FAILED（error_code：`stream_aborted` / `stream_error`），不回滚已持久化消息；run 不得遗留 RUNNING
- thread 删除一律软删；list/detail 过滤 `deleted_at`
- 响应头 `X-Petrichor-Assistant-Thread-Id` / `X-Petrichor-Assistant-Run-Id`（与旧栈 `X-Petrichor-Agent-*` 区分）
- 问答链路禁止注册 `propose_wiki_patch`；当前 12 个工具名与 roadmap 4.3 锁定表恰好相等
- 扩展点：模型解析后是记忆注入位（4.6）；注册表是工具域扩展位（4.3）；流回调是韧性策略位（4.7）；工具执行前是确认协议位（4.4）
