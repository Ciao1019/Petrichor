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
---

# 站内 Assistant 运行时

站内统一对话运行时（chat-first-universal-agent 的底座），代码在 `apps/web/src/server/assistant/`，路由在 `apps/web/app/api/assistant/**`。当前状态：Mastra Agent 运行时；knowledge / doc_library / system / content_write 域已就绪；Chat-first 壳在 `/dashboard/assistant`。

## 结构与交互

```
POST /api/assistant/chat（SSE, requireCurrentUser）
  鉴权 → zod 校验 → focus 归属校验(403) → ensureAssistantThread(404)
  → 持久化 user message → 解析模型(无配置→409) → routeAssistantIntent
  → knowledge/doc_library 命中时在路由器内补 system 辅助域
  → createAssistantRun →（若有确认回传）executeConfirmedDangerousAction
  → loadMastraToolsForDomains(按意图装载子集，排除 risk=dangerous)
  → Mastra Agent.stream(maxSteps=8) → toAISdkStream → SSE UIMessage 流
  回调：afterToolCall→recordAssistantStep；onFinish/onError→finish run
```

- **运行时栈**：`@mastra/core` `Agent` + `@mastra/ai-sdk` `toAISdkStream`（v6）；生产环境挂 PromptInjectionDetector + TokenLimiterProcessor（DeepSeek 等走 `jsonPromptInjection`）。
- **域工具注册表**（`tool-registry.ts`）：`registerAssistantTools` / `loadMastraToolsForDomains(domains, ctx)` → Mastra `createTool` 集合；`risk=dangerous` **不对模型暴露**，仅经确认后由 Runtime 按名执行。
- **knowledge / doc_library / system**：同前（12 个只读锁名工具）。
- **content_write**（`tools/content-write.ts` + `confirmation.ts`）：`request_user_confirmation`、`create_article`、`update_article`、`create_article_share`；危险：`delete_article` / `revoke_article_share` / `delete_document`（白名单映射 article.delete / share.revoke / document.delete）。确认回传 `{ confirmed, confirmationId }` 后 Runtime 写入 `executionOutcome` 并落 step。
- **意图路由**（`intent-router.ts`）：规则打分；写意图命中 `content_write`；knowledge/doc_library 补 system。
- **壳**：`/dashboard/assistant`；Plan/Progress 在右侧 `AssistantTaskRail`；确认卡消息内 `ApprovalCard`。
- 域枚举 `AgentDomainId`：`knowledge | doc_library | system | content_write | admin`

## 数据与状态

5 张表（`schema.ts` + `full-migration.ts`，契约 roadmap 4.5）：

- `petrichor_assistant_thread`：user_id / title / focus_json / **deleted_at（软删）**
- `petrichor_assistant_message`：thread_id / role / content_json（完整 UIMessage parts，供回放）
- `petrichor_assistant_run`：status（RUNNING/COMPLETED/FAILED）/ model_config_id / intent_domains_json / error_code
- `petrichor_assistant_step`：run_id / step_index / tool_name / input_json / output_json / **error_code** / duration_ms
- `petrichor_assistant_artifact`：`save_answer_artifact` 写入

与旧 `petrichor_kb_agent_*` / `petrichor_doc_qa_*` 完全独立。确认态不另建表，落在消息 tool parts。

## 已知约束

- **每轮先意图路由再装载工具子集，禁止一次挂载全站 tools**（roadmap 4.1）；knowledge/doc_library 只辅助加入 system，不因此加入 content_write/admin
- **确认协议**（roadmap 4.4）：危险操作经 `request_user_confirmation`；`confirmed=true` 由 Runtime 执行；取消无副作用；直接调危险工具名被拒
- 工具包装继续调用既有 userId 归属查询；focus 只提供默认范围
- **韧性包装**（`tool-resilience.ts`）：超时 30s / 同名连败≥2；Plan/进度侧栏 live 展示
- 流开始前错误走非流 JSON；流开始后标记 run FAILED（`stream_aborted` / `stream_error`）
- 问答链路禁止注册 `propose_wiki_patch`；admin 域工具尚未注册（归 `agent-tools-admin`）
- 扩展点：注册表是工具域扩展位；确认执行器可挂更多 dangerous 白名单映射
