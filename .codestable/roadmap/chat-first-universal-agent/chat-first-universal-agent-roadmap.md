---
doc_type: roadmap
slug: chat-first-universal-agent
status: active
created: 2026-07-10
last_reviewed: 2026-07-10
tags: [agent, chat-first, assistant, knowledge-base, doc-library]
related_requirements:
  - chat-first-universal-agent
related_architecture: []
---

# Chat-first 全站通用 Agent

## 1. 背景

站内能力散落在知识库问答、文档库问答、记忆页等入口，半成品感强。愿景（见 `requirements/chat-first-universal-agent.md`）是：登录后主界面就是对话，用说话查看和操作系统里的事；知识库与文档库的手动操作界面保留；对外 MCP / Skill / API Key 产品线不动。

本 roadmap 把该愿景拆成可独立走 feature 流程的模块与子 feature，并先锁定跨 feature 的接口契约。

上游材料：

- `.codestable/requirements/chat-first-universal-agent.md`
- `.codestable/brainstorms/chat-first-universal-agent/brainstorm.md`

## 2. 范围与明确不做

### 本 roadmap 覆盖

- Chat-first 壳作为 Dashboard 主入口（业务 CRUD 页保留）
- 统一站内 Assistant 运行时：意图路由、记忆、规划/任务、基础韧性
- 按域装载的工具：知识只读/问答、文档库只读/问答、系统元信息、内容写入、管理面
- 危险操作确认协议
- 退役分散站内问答入口与记忆主入口；问答链路移除 Wiki 补丁工具

### 明确不做

- 不改对外 `/api/agent/**`、MCP、Skill、API Key 接入产品线
- 不取消知识库、文档库等原有手动操作界面
- 一期不做子代理与团队、深度上下文压缩（二期已拆为 `agent-context-compress` / `agent-subagents`）
- 不把公开访客 `/ask` 并入本壳（可另开 roadmap / feature）
- 不在本 roadmap 接入 Langfuse 等外部 tracing（见观察项）

## 3. 模块拆分（概设）

```
chat-first-universal-agent
├── Assistant Runtime：统一对话入口、意图路由、域工具装载、run/step、韧性
├── Memory：跨会话记忆蒸馏与注入（服务全体话，不绑单一知识库）
├── Tool Domains：按域注册的只读 / 可写 / 管理工具
├── Confirmation：危险操作确认卡协议（前后端）
├── Chat Shell：Chat-first 主界面与上下文抽屉
└── Legacy Retirement：旧 QA / 记忆入口拆除与会话归档
```

### 模块 · Assistant Runtime

- **职责**：提供统一 `/api/assistant/*` 对话与线程；意图路由；按域装载工具；持久化 run/step；基础韧性策略。不负责具体业务 CRUD UI。
- **承载的子 feature**：`agent-runtime-core`, `agent-plan-resilience`, `agent-context-compress`, `agent-subagents`
- **触碰的现有代码**：吸收并逐步替代 `POST /api/kb/agent/chat`（Mastra）与 `POST /api/doc-library/chat`（AI SDK）两套栈；**站内统一运行时锁定为 Mastra Agent**（对外 SSE 经 `toAISdkStream`）；新建 assistant 模块，不占用 `/api/agent/**`

### 模块 · Memory

- **职责**：每轮注入记忆段、异步蒸馏；管理 API 保留但不再做主入口页。
- **承载的子 feature**：`agent-memory-runtime`
- **触碰的现有代码**：扩展 `server/kb/agent-memory*.ts` 与相关表，使记忆服务全体话而非仅 KB chat

### 模块 · Tool Domains

- **职责**：按 `AgentDomainId` 注册工具；一期锁定只读工具名与危险白名单；写入与管理面分批扩展。
- **承载的子 feature**：`agent-tools-readonly`, `agent-confirm-write`（写工具部分）, `agent-tools-admin`
- **触碰的现有代码**：复用 wiki 树检索、doc-library 检索、既有业务 handlers；禁止在问答链路再注册 `propose_wiki_patch`

### 模块 · Confirmation

- **职责**：危险操作必须经确认卡往返后才执行副作用。
- **承载的子 feature**：`agent-confirm-write`
- **触碰的现有代码**：接线 `components/tool-ui/approval-card`

### 模块 · Chat Shell

- **职责**：Dashboard 默认对话主界面；线程列表、焦点上下文、任务/确认/引用等 Tool UI。
- **承载的子 feature**：`agent-chat-shell`
- **触碰的现有代码**：`client-app.tsx` 路由、`dashboard-routes.ts`、侧栏；复用 assistant-ui 与 tool-ui

### 模块 · Legacy Retirement

- **职责**：退役分散 QA / 记忆主入口；移除 agent 侧 Wiki 补丁工具；旧会话只读归档。
- **承载的子 feature**：`agent-legacy-retire`
- **触碰的现有代码**：`/dashboard/qa`、`/dashboard/doc-library/qa`、`/dashboard/agent-memory`、Mastra `propose_wiki_patch`

## 4. 模块间接口契约 / 共享协议（架构层详设）

> 以下契约是后续 `cs-feat-design` 的硬约束。要改必须先 `cs-roadmap update`。

### 4.1 统一对话流

**方向**：Chat Shell → Assistant Runtime  
**形式**：HTTP SSE（AI SDK UIMessage stream）

```
POST /api/assistant/chat
Auth: requireCurrentUser（cookie session；禁止 Agent API Key）

Request:
  {
    threadId?: string | number | null
    messages: UIMessage[]
    configId?: string | number | null
    focus?: {
      knowledgeBaseId?: string | null
      libraryId?: string | null
      articleId?: string | null
      documentId?: string | null
    }
  }

Response headers:
  X-Petrichor-Assistant-Thread-Id: string
  X-Petrichor-Assistant-Run-Id: string
Body: text/event-stream（createUIMessageStreamResponse）

错误（非流，JSON { code, msg, path, timestamp }）:
  401 unauthorized
  400 invalid_input
  403 forbidden              // 焦点实体非当前用户所有
  404 thread_not_found
  409 model_not_configured
```

**约束**：

- 不得占用 `/api/agent/**`（外部集成保留）
- `focus` 只约束默认上下文，不禁止跨域工具
- 每轮先跑意图路由，再按结果装载工具子集；禁止一次挂载全站 tools

### 4.2 意图路由结果形状

**方向**：Runtime 内部稳定契约（多 feature 共用）  
**形式**：函数返回值

```
type AgentDomainId =
  | "knowledge"
  | "doc_library"
  | "system"
  | "content_write"
  | "admin"

type IntentRouteResult = {
  domains: AgentDomainId[]     // 1..N，按优先级排序
  confidence: number           // 0..1
  rationale?: string           // 仅日志/调试，可不进 UI
}

function routeAssistantIntent(input: {
  userText: string
  focus: Focus | null
  recentToolNames: string[]
}): Promise<IntentRouteResult>
```

**约束**：

- `domains` 为空时默认 `["system", "knowledge", "doc_library"]`（只读三域）
- 当 `domains` 含 `knowledge` 或 `doc_library` 时，必须把 `system` 作为辅助域一并加入（若尚未包含）；补齐后的同一域集合同时用于 run 的 `intent_domains_json` 落库与 `loadToolsForDomains` 装载
- 上述辅助域合并仍不是加载全站 tools：不得因此加入 `content_write` / `admin`，除非路由本身命中对应域
- 含写操作意图时必须包含 `content_write` 或 `admin`，并走确认策略
- 路由实现可换（规则 / 小模型），结果形状不可改，除非 roadmap update

### 4.3 域工具注册表

**方向**：Tool Domains → Runtime  
**形式**：进程内注册 API

```
type AssistantToolRegistration = {
  name: string                 // 全局唯一，snake_case
  domain: AgentDomainId
  risk: "read" | "write" | "dangerous"
  description: string
  inputSchema: ZodTypeAny
  execute: (ctx, input) => Promise<unknown>
}

function registerAssistantTools(tools: AssistantToolRegistration[]): void
function loadToolsForDomains(domains: AgentDomainId[]): ToolSet
```

**一期必须注册的只读工具（名称锁定）**：

| name | domain | 行为摘要 |
|------|--------|----------|
| `list_knowledge_bases` | knowledge | 当前用户知识库列表 |
| `search_knowledge` | knowledge | Wiki 树 / 语义 / 关键词检索（实现可组合现有） |
| `read_knowledge_node` | knowledge | 读 Wiki 页或源文章 |
| `list_doc_libraries` | doc_library | 文档库列表 |
| `search_documents` | doc_library | 文档检索 |
| `read_document` | doc_library | 读文档内容 |
| `list_system_overview` | system | 计数与状态：知识库数、文档库数、模型是否就绪等 |
| `show_progress` | system | UI 进度（risk=read） |
| `show_citations` | system | UI 引用 |
| `show_data_table` | system | UI 表格 |
| `save_answer_artifact` | system | 保存回答产物 |
| `upsert_plan` | system | 写入 / 更新可见任务计划 |

**一期禁止再注册**：`propose_wiki_patch`（问答链路移除 Wiki 补丁）

### 4.4 确认协议

**方向**：Confirmation ↔ Chat Shell  
**形式**：tool UI 载荷 + tool result 回传

危险工具不直接执行，先返回：

```
tool name: request_user_confirmation
output（对齐 approval-card schema 并扩展）:
  {
    id: string
    title: string
    description?: string
    variant?: "default" | "destructive"
    confirmLabel?: string
    cancelLabel?: string
    action: {
      toolName: string
      input: Record<string, unknown>
    }
    risk: "dangerous"
  }
```

用户确认后，客户端以 tool result 回传：

```
{ confirmed: true | false, confirmationId: string }
```

- `confirmed=true`：Runtime 才执行 `action.toolName`
- `confirmed=false`：run 内标记取消，不执行副作用

**危险动作白名单（`risk=dangerous` 必须走确认）**：

```
article.delete
folder.delete
knowledge_base.delete
document.delete
document.bulk_delete
share.revoke
ai_config.delete
ai_config.update_credentials
agent_api_key.revoke
public_qa.disable
```

- `risk=write`：可直接执行
- `risk=read`：禁止产生写副作用

### 4.5 线程与持久化

**方向**：Runtime 持久化（Shell / Memory 共用）  
**形式**：共享数据库表 + HTTP API

```
表 petrichor_assistant_thread
  id, user_id, title,
  focus_json jsonb null,
  created_at, updated_at, deleted_at

表 petrichor_assistant_message
  id, thread_id, role, content_json, created_at

表 petrichor_assistant_run
  id, thread_id, status, model_config_id,
  intent_domains_json, error_code null,
  started_at, finished_at

表 petrichor_assistant_step
  id, run_id, step_index, tool_name,
  input_json, output_json, status, duration_ms

表 petrichor_assistant_artifact
  id, thread_id, run_id null, kind, title, content_json, created_at
```

**Thread API**：

```
POST /api/assistant/thread/list
  { cursor?, limit?, q? } → { items, nextCursor? }

POST /api/assistant/thread/detail
  { threadId } → { thread, messages }

POST /api/assistant/thread/create
  { title?, focus? } → { thread }

POST /api/assistant/thread/delete
  { threadId } → { ok: true }

POST /api/assistant/thread/delete-many
  { threadIds: string[] } → { deleted: number }
```

旧表 `petrichor_kb_agent_*` / `petrichor_doc_qa_*`：**只读归档**，不自动迁移进新表（除非单开迁移 feature）。

### 4.6 记忆

**方向**：Memory → Runtime  
**形式**：函数调用 + 管理 API

```
loadAssistantMemoryPromptSection(userId): Promise<string | null>
scheduleAssistantMemoryDistillation(userId): void

POST /api/assistant/memory/list
POST /api/assistant/memory/delete
POST /api/assistant/memory/distill
```

- list 响应形状兼容现有 memory list（`items` + `state`）
- kind 仍为 `PREFERENCE | TOPIC | FACT`
- 管理入口挂设置 / 抽屉，不再做独立主入口页

### 4.7 规划与韧性

**方向**：Runtime → Chat Shell  
**形式**：tool 输出 + run/step 状态约定

```
Plan（upsert_plan 输出，对齐现有 plan schema）:
  {
    id: string
    title: string
    description?: string
    todos: [{
      id: string
      label: string
      status: "pending" | "in_progress" | "completed" | "cancelled"
      description?: string
    }]
  }

韧性（一期最低要求）:
  - 单 tool 超时：step failed，允许模型改用备用工具或降级回答
  - 同一 tool 连续失败 ≥2：本 run 不再重试该 tool，
    step.error_code = tool_retry_exhausted
  - 模型流中断：run.status = failed，error_code = stream_aborted；
    已产生的 step 保留
```

### 4.8 Chat Shell 路由

**方向**：Chat Shell / Legacy → 前端路由  
**形式**：react-router 路径约定

```
登录后默认落地：assistant 壳
路径：在 feature-design 中于下列二选一并全仓统一
  - /dashboard/assistant
  - 或将 /dashboard 默认渲染为 assistant 壳

退役（由 agent-legacy-retire 执行）:
  /dashboard/qa              → 重定向到 assistant
  /dashboard/doc-library/qa  → 重定向到 assistant
  /dashboard/agent-memory    → 重定向到设置内记忆管理或 assistant 设置抽屉

保留:
  /dashboard/knowledge/**
  /dashboard/doc-library/**（除 /qa）
  /dashboard/wiki
  /dashboard/agent/keys|logs|mcp|skill
  /dashboard/ai/**
```

### 4.9 深度上下文压缩

**方向**：Assistant Runtime 内部（Chat 流装载前）  
**形式**：线程级摘要 + 消息窗口策略

```
表 petrichor_assistant_thread 扩展（本契约允许增量列，不另建表）:
  context_summary_md text null          // 已折叠历史的中文摘要
  context_summary_until_message_id bigint null  // 摘要覆盖到的最后一条 message.id（含）
  context_summary_updated_at timestamptz null

type ContextPack = {
  summaryMd: string | null              // 注入 system/上下文段；无则 null
  recentMessages: UIMessage[]           // 未折叠的最近轮次（原始）
  compressedMessageCount: number        // 已被摘要覆盖的消息条数
}

function buildContextPack(input: {
  threadId: number
  messages: UIMessage[]                 // 本轮客户端提交的 messages
  tokenBudget: number                   // 与 TokenLimiter 对齐的预算
}): Promise<ContextPack>
```

**约束**：

- `TokenLimiterProcessor` 仍保留为硬裁剪兜底；本契约是**语义压缩**（摘要折叠），不是替代硬裁剪
- 必须保留最近至少 **N=6** 条原始消息（或最近 3 轮 user/assistant）不进摘要，避免丢当前任务细节
- 摘要失败 / 超时：降级为仅硬裁剪，本轮照常回答，不得阻断对话
- 摘要写入须带 `user_id` 归属校验；不向客户端单独暴露「压缩 API」（随 chat 内部发生）
- 禁止把危险确认未决态、API Key 明文写进摘要

### 4.10 子代理与团队

**方向**：主 Agent ↔ 子 Agent（Runtime 内嵌套）  
**形式**：主对话可调用的委派工具 + step / metadata 可观测

```
// MVP：单类委派工具（名称锁定）；「团队」= 可并行多次委派，不另建编排引擎
tool name: spawn_research_subagent
domain: system
risk: read
input:
  {
    goal: string                        // 子任务目标（中文）
    domains: AgentDomainId[]            // 子集，仅允许 knowledge | doc_library | system
    focus?: Focus | null                // 可继承主对话 focus
  }
output:
  {
    ok: boolean
    summary: string                     // 子代理最终结论（给主 Agent 继续用）
    citations?: Array<{ title, href?, domain?, snippet? }>
    usage?: { calls: number, totalTokens: number }
    errorCode?: string | null           // 超时 / 耗尽等，对齐 step.error_code 语义
  }
```

**约束**：

- 子代理**不得**装载 `content_write` / `admin`，也不得执行 `risk=dangerous`（确认协议只在主对话）
- 子代理复用同一用户 `userId` 与模型配置；独立 `maxSteps`（建议 ≤6）与工具超时（复用韧性包装）
- 子代理每次工具调用须写入当前 run 的 `petrichor_assistant_step`（`tool_name` 可用 `spawn_research_subagent/<inner>` 或等价可区分前缀）
- 对外 SSE 仍是主对话 UIMessage 流；子代理过程通过 `show_progress` / 侧栏任务或 message metadata `subAgentUsage` 呈现，不新开 HTTP 入口
- 禁止一次挂载全站 tools；子代理 `domains` 也必须走 `loadMastraToolsForDomains`
- 「多 Agent 团队编排 DSL / 持久化团队定义」不在本契约；需要时另开 roadmap update

## 5. 子 feature 清单

1. **agent-runtime-core** — 新建 `/api/assistant/chat` + thread 表/API + 域注册表 + `routeAssistantIntent` 骨架
   - 所属模块：Assistant Runtime
   - 依赖：无
   - 状态：done（2026-07-10 验收）
   - 对应 feature：`features/2026-07-10-agent-runtime-core/`

2. **agent-tools-readonly** — 注册 knowledge / doc_library / system 只读工具（含 `list_system_overview`）
   - 所属模块：Tool Domains
   - 依赖：`agent-runtime-core`（需要注册表与 chat 入口）
   - 状态：done（2026-07-10 验收）
   - 对应 feature：`features/2026-07-10-agent-tools-readonly/`

3. **agent-chat-shell** — Chat-first 主界面接通统一 API（线程侧栏、焦点、基础 Tool UI）
   - 所属模块：Chat Shell
   - 依赖：`agent-runtime-core`, `agent-tools-readonly`
   - 状态：done（2026-07-10 验收）
   - 对应 feature：`features/2026-07-10-agent-chat-shell/`
   - 备注：最小闭环

4. **agent-memory-runtime** — 记忆注入全体话 + 蒸馏；记忆管理降级为设置/抽屉
   - 所属模块：Memory
   - 依赖：`agent-runtime-core`（需要统一 chat 钩子）
   - 状态：**cancelled**（2026-07-10 用户裁决：记忆/蒸馏整段下线）
   - 对应 feature：未启动

5. **agent-plan-resilience** — `upsert_plan` 可见任务 + 工具超时/重试耗尽策略
   - 所属模块：Assistant Runtime + Chat Shell
   - 依赖：`agent-chat-shell`（需要 UI 展示计划与失败态）
   - 状态：done（2026-07-10 验收；Plan 仅消息内卡；超时 30s；step.error_code）
   - 对应 feature：`features/2026-07-10-agent-plan-resilience/`

6. **agent-confirm-write** — 确认协议 + 内容写工具（建文/改文/移动/分享等）+ 危险白名单
   - 所属模块：Confirmation + Tool Domains
   - 依赖：`agent-chat-shell`（需要确认卡 UI）
   - 状态：done（2026-07-10 验收；确认协议 + 最小写/危险集；危险不对模型暴露）
   - 对应 feature：`features/2026-07-10-agent-confirm-write/`

7. **agent-tools-admin** — 管理面工具（AI 配置、公开问答开关、Agent Key 查询/吊销等）
   - 所属模块：Tool Domains
   - 依赖：`agent-confirm-write`（写/危险复用确认）
   - 状态：done（2026-07-10 验收；8 工具；admin→content_write 辅助域）
   - 对应 feature：`features/2026-07-10-agent-tools-admin/`

8. **agent-legacy-retire** — 下线旧 QA/记忆主入口；移除 agent 侧 `propose_wiki_patch`；侧栏改入口
   - 所属模块：Legacy Retirement
   - 依赖：`agent-chat-shell`（记忆条已取消，不再依赖）
   - 状态：done（2026-07-10 提前执行：删站内知识/文档问答、公开 `/ask`、记忆页与蒸馏；Wiki 与 assistant 保留；旧会话表不 DROP）
   - 对应 feature：无独立 design（用户直接拍板执行）

9. **agent-subagents-compress** — （已拆分）原「子代理 + 深度压缩」合并条
   - 所属模块：Assistant Runtime
   - 状态：**dropped**（2026-07-10 拆为下列两条，避免单 feature 过大）
   - 对应 feature：未启动

10. **agent-context-compress** — 深度上下文压缩（线程摘要 + 保留最近轮次）
    - 所属模块：Assistant Runtime
    - 依赖：`agent-plan-resilience`（复用韧性/超时语义；TokenLimiter 已存在）
    - 状态：done（2026-07-10 验收；含压缩中 UI）
    - 对应 feature：`features/2026-07-10-agent-context-compress/`
    - 契约：第 4.9 节

11. **agent-subagents** — 子代理与团队 MVP（`spawn_research_subagent`）
    - 所属模块：Assistant Runtime
    - 依赖：`agent-plan-resilience`, `agent-tools-admin`, `agent-context-compress`（先压缩再嵌套，降低子代理撑爆上下文）
    - 状态：planned
    - 对应 feature：未启动
    - 契约：第 4.10 节

**最小闭环**：第 3 条 `agent-chat-shell` 做完后，登录用户可在一个对话里问「有多少个知识库」，并检索知识库与文档库内容。

## 6. 排期思路

按技术依赖推进：先 Runtime 与只读工具，再上壳形成最小闭环；规划与韧性补「成熟感」；写入与管理面随后。记忆能力已取消。二期先做上下文压缩，再做子代理（依赖压缩），不挡一期。

技术依赖之外的产品优先级（例如是否提前做 admin）由用户在启动各子 feature 时拍板。

## 7. 观察项

- 旧 KB / Doc thread 表保留不 DROP，应用层已停用；是否提供只读归档浏览：未定
- Langfuse / 统一 tracing：建议另开，不塞进韧性最低条
- 文档库向量检索对齐知识库：非本愿景门闩；若只读检索体验不足可另开 feature
- Wiki 页上的补丁审批 UI 是否整页删除：问答链路已不再提出补丁；Wiki 页存量审批另定
- 公开 `/ask` 已下线，后续若重开需另开 feature

## 8. 变更日志

- 2026-07-10：第 4.7 节 Plan schema `todos[].status` 的 `"done"` 修正为 `"completed"`（单词级笔误：该节自称对齐现有 plan schema，而现有组件 `tool-ui/plan/plan.tsx` 实际用 `completed`；用户拍板以组件为准，不改组件）。存量影响：`agent-runtime-core`（done）未触及 Plan schema，不受影响；`agent-tools-readonly`（in-progress，本修正的发起方）与后续 `agent-plan-resilience` / `agent-chat-shell` 按修正后契约实现。
- 2026-07-10：第 4.2 节新增只读辅助域约束：路由命中 `knowledge` / `doc_library` 时同时加入 `system`，且 run 落库与工具装载使用同一域集合。理由：`show_progress` / `show_citations` / `show_data_table` / `upsert_plan` / `save_answer_artifact` 均锁在 `system` 域，否则带 focus 的知识库或文档库问答无法调用引用等 UI 工具；该规则仍不自动加入 `content_write` / `admin`。存量影响：`agent-runtime-core`（done）的 `intent-router` 行为需按新约束调整；`agent-tools-readonly`（in-progress）步骤 4 依赖本补丁完成接线与验证。
- 2026-07-10：**运行时栈纠偏为 Mastra**。用户确认站内通用 Agent 应以 Mastra 为执行层（非 AI SDK `streamText`）。`POST /api/assistant/chat` 改为 `@mastra/core` `Agent` + `@mastra/ai-sdk` `toAISdkStream`；域注册表新增 `loadMastraToolsForDomains`；对外 SSE 仍为 AI SDK UIMessage。存量影响：`agent-runtime-core` / `agent-tools-readonly` 的执行层实现替换，HTTP/表/工具名契约不变；前端壳无需改。
- 2026-07-10：**取消记忆 + 提前拆旧入口**。用户裁决：站内只保留 `/dashboard/assistant` 对话；删除知识问答、文档问答、公开 `/ask`、Agent 记忆页与蒸馏管道；知识 Wiki 保留；旧会话/记忆表不 DROP。`agent-memory-runtime` → cancelled；`agent-legacy-retire` → done（依赖改为仅 chat-shell）。
- 2026-07-10：**agent-plan-resilience 完成**。拍板：Plan 仅消息内卡、超时 30s；落地 `tool-resilience` + `step.error_code`；流中断 `stream_aborted` 保留。
- 2026-07-10：**agent-confirm-write 完成**。确认协议 + content_write 最小写/危险工具；危险不对模型暴露；壳 ApprovalCard。
- 2026-07-10：**agent-tools-admin 完成**。admin 域 8 工具；路由辅助 content_write；公开问答开关需超管。
- 2026-07-10：**二期拆分**。`agent-subagents-compress` → dropped；新增 `agent-context-compress`（契约 4.9）与 `agent-subagents`（契约 4.10）；推荐顺序压缩 → 子代理。
- 2026-07-10：**agent-context-compress 完成**。线程摘要 + 最近 6 条；流内压缩中 UI；TokenLimiter 兜底。
