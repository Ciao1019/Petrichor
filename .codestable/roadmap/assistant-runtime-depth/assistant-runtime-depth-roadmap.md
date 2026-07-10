---
doc_type: roadmap
slug: assistant-runtime-depth
status: active
created: 2026-07-10
last_reviewed: 2026-07-10
tags: [agent, assistant, plan, resilience, context, subagent]
related_requirements:
  - chat-first-universal-agent
related_architecture:
  - runtime-assistant
---

# Assistant 运行时深度（计划 / 压缩 / 子代理）

## 1. 背景

`chat-first-universal-agent` 已交付「一个入口查事办事」的闭环，但下列三块仍是**一期最小面**：

| 面 | 现状（MVP） | 深度缺口 |
|----|-------------|----------|
| 计划 / 韧性 | 超时 30s、连败耗尽、`error_code`；Plan/进度在侧栏 live，**不落库** | Plan 跨轮持久化与回放；更细的失败分类与换招策略 |
| 上下文压缩 | 时间序摘要 + 固定最近 6 条 + TokenLimiter | 动态窗口；向量「相关历史召回」 |
| 子代理 | 单次 `spawn_research_subagent` 只读嵌套 | 有限再 spawn；写子代理（确认回主对话）；多 Agent 协作 |

本 roadmap 只加深这三块，不重开「全站工具面」或记忆蒸馏（记忆仍保持 cancelled，除非另开 req）。

上游：

- `.codestable/requirements/chat-first-universal-agent.md`
- `.codestable/roadmap/chat-first-universal-agent/`（一期已 done）
- `.codestable/architecture/runtime-assistant.md`

## 2. 范围与明确不做

### 覆盖

- Plan 持久化与侧栏回放
- 韧性策略加深（失败分类 / 换招 playbook）
- 上下文窗口策略升级 + 可选向量历史召回
- 子代理：再委派深度、写能力（经确认）、多 Agent 协作 MVP

### 明确不做

- 不改 `/api/agent/**`、MCP、Skill、API Key 产品线
- 不恢复跨会话记忆蒸馏（除非另开 requirement）
- 不做 Langfuse 全量接入（可另开；本条只要求 step/run 可观测字段够用）
- 不做「无限再 spawn」或子代理直接执行 dangerous（确认永远在主对话）
- 不把文档库向量对齐知识库绑进本 roadmap（仍属观察项，可并行另开）

## 3. 模块拆分（概设）

```
assistant-runtime-depth
├── Plan Persistence：Plan 落库、按 thread 回放、侧栏与消息对齐
├── Resilience Playbook：失败分类、换招策略、与 step.error_code 对齐
├── Context Depth：动态窗口 +（可选）向量相关历史召回
└── Subagent Depth：再 spawn 限额、写子代理、多 Agent 协作
```

### 模块 · Plan Persistence

- **职责**：把 `upsert_plan` 的可见计划从「仅本轮消息/侧栏 live」升级为 thread 级可回放状态。
- **触碰**：`assistant` 表结构、`upsert_plan` 执行侧、`AssistantTaskRail` / Plan UI。
- **说明**：侧栏壳已存在；本模块补的是**持久化与跨轮一致**，不是从零做 sticky UI。

### 模块 · Resilience Playbook

- **职责**：在现有 timeout / retry_exhausted 之上，定义可执行的换招策略（何时提示模型换工具、何时降级只答、是否自动禁用某 tool 名）。
- **触碰**：`tool-resilience.ts`、`chat-handler` 提示词/钩子、step 元数据。

### 模块 · Context Depth

- **职责**：升级 `buildContextPack`：动态保留窗口；可选对历史消息做 embedding 召回再注入。
- **触碰**：`context-pack.ts`、thread 摘要列、可能新增 message embedding 存储。

### 模块 · Subagent Depth

- **职责**：扩展委派协议：depth 限额、写域子代理经主对话确认、多子代理并行/汇总结论。
- **触碰**：`research-subagent.ts`、确认协议、壳 Tool UI / usage。

## 4. 模块间接口契约 / 共享协议

> feature-design 硬约束。要改先 `cs-roadmap update`。

### 4.1 Plan 持久化

**方向**：Runtime ↔ Shell  
**形式**：表 + 既有 `upsert_plan` 工具语义扩展

```
表 petrichor_assistant_plan（新建）
  id bigint PK
  thread_id bigint not null          // 归属线程
  user_id bigint not null
  plan_key text not null             // 与 upsert_plan.id 对齐
  title text not null
  description text null
  todos_json text not null           // Plan.todos 序列化
  status text not null               // active | archived
  updated_at / created_at

唯一：(thread_id, plan_key) where status = active（实现可用部分唯一或应用层保证）

upsert_plan 执行时：
  - 仍返回 Plan 形状给 UI
  - 同时 upsert 上表（同 plan_key 覆盖 todos/title）

thread/detail 响应扩展（可选字段，向后兼容）：
  plans?: Plan[]                     // 该线程 active plans，供侧栏冷启动
```

**约束**：

- 不另造第二套 Plan schema；todos.status 仍为 `pending | in_progress | completed | cancelled`
- 删除线程（软删）后 plan 不可被 list；物理清理可延后
- 侧栏优先读「本轮 live tool 输出」，无 live 时回落 `plans[]`

### 4.2 韧性 Playbook

**方向**：Runtime 内部  
**形式**：错误码扩展 + 策略表（代码常量即可，不必新表）

```
既有 error_code:
  tool_timeout | tool_retry_exhausted | tool_error | stream_aborted | stream_error

新增（本 roadmap 允许）：
  tool_degraded          // 已按 playbook 降级，模型应换招或直接回答
  tool_circuit_open      // 本 run 内该工具名已熔断

type ResilienceDecision = {
  action: "retry_other_tool" | "answer_without_tool" | "circuit_open"
  messageForModel: string            // 注入工具结果或系统提示片段
}

function decideToolFailure(input: {
  toolName: string
  errorCode: string
  failStreak: number
}): ResilienceDecision
```

**约束**：

- 不自动静默换另一个工具代执行（避免越权副作用）；只**指导模型**换招或降级回答
- dangerous / 确认流程不受 playbook 自动执行影响
- 超时仍默认 30s，除非单 feature 明确调整并写进验收

### 4.3 上下文深度

**方向**：Runtime 内部（Chat 装载前）  
**形式**：扩展 ContextPack（兼容 4.9）

```
type ContextPack = {
  summaryMd: string | null
  recentMessages: UIMessage[]
  compressedMessageCount: number
  recalledSnippets?: Array<{          // 新增，可选
    messageId: string
    score: number
    excerpt: string
  }>
  windowPolicy: {
    recentCount: number               // 动态，下限仍 ≥ 6
    reason: "fixed" | "token_budget" | "turn_budget"
  }
}

// 向量召回（可选子 feature）
表或列：assistant_message 级 embedding（实现可选独立表）
  message_id, thread_id, user_id, embedding vector, excerpt_md
```

**约束**：

- TokenLimiter 硬裁剪仍保留
- 召回片段注入 instructions，不伪造用户气泡
- 无 embedding 配置时召回静默跳过，不阻断对话
- 禁止把 API Key / 确认未决态写入召回摘要

### 4.4 子代理深度

**方向**：主 Agent ↔ 子 Agent  
**形式**：扩展委派工具协议（兼容 4.10）

```
// 保留 spawn_research_subagent；扩展输入
input 增量:
  {
    goal: string
    domains: AgentDomainId[]          // 只读集仍默认；写子代理见下
    focus?: Focus | null
    depth?: number                    // 默认 0；子代理内再 spawn 时 +1
    maxDepth?: number                 // 全局上限，契约锁定 ≤ 2
  }

// 写子代理（新工具名，锁定）
tool name: spawn_write_subagent
domain: content_write                 // 或 system + 辅助装载 content_write
risk: read                            // 委派本身只读；真正写仍走确认
input:
  {
    goal: string
    proposedActions?: Array<{ toolName: string, input: object }>
  }
约束：
  - 子代理不得直接执行 risk=dangerous
  - 需要副作用时：子代理只能 request_user_confirmation 或把 action 交回主对话确认
  - 禁止子代理再调用 spawn_write_subagent（防递归写）

// 多 Agent 协作 MVP（新工具或编排入口，名称在对应 feature design 锁定）
- 允许同一 run 内并行 ≤ 3 个只读 spawn_research_subagent
- 主 Agent 负责汇总结论；不引入外部编排引擎 / 持久化「团队定义」DSL
```

**约束**：

- `maxDepth` 默认 1（仅允许一层再 spawn）；feature 可降到 0 保持现状
- 写子代理不绕过确认白名单
- 内层 step 前缀规则保持：`spawn_*/<innerTool>`

## 5. 子 feature 清单

1. **agent-plan-persist** — Plan 落库 + thread.detail 回放 + 侧栏冷启动  
   - 模块：Plan Persistence  
   - 依赖：无（一期壳与 upsert_plan 已存在）  
   - 状态：planned  
   - **最小闭环**  
   - 契约：4.1  

2. **agent-context-window-v2** — 动态最近窗口（按 token/轮次，下限 6）+ 摘要策略微调  
   - 模块：Context Depth  
   - 依赖：无（在现有 context-pack 上演进）  
   - 状态：planned  
   - 契约：4.3（无召回也可先交付 windowPolicy）  

3. **agent-resilience-playbook** — 失败分类 + 换招/降级文案注入 + circuit_open  
   - 模块：Resilience Playbook  
   - 依赖：无（可与 1/2 并行；建议在 plan-persist 后，便于侧栏展示降级态）  
   - 状态：planned  
   - 契约：4.2  

4. **agent-context-vector-recall** — 历史消息 embedding + 相关片段召回注入 ContextPack  
   - 模块：Context Depth  
   - 依赖：`agent-context-window-v2`（先有稳定 ContextPack 扩展点）  
   - 状态：planned  
   - 契约：4.3  

5. **agent-subagent-depth-limit** — `depth/maxDepth`；允许有限再 spawn（默认 maxDepth=1）  
   - 模块：Subagent Depth  
   - 依赖：无（在现有 spawn_research_subagent 上扩展）  
   - 状态：planned  
   - 契约：4.4  

6. **agent-subagent-write** — `spawn_write_subagent`；写意图经确认回主对话  
   - 模块：Subagent Depth  
   - 依赖：`agent-subagent-depth-limit`（复用 depth 防护）；一期 confirm-write 已存在  
   - 状态：planned  
   - 契约：4.4  

7. **agent-multi-agent-fanout** — 同 run 并行 ≤3 只读子代理 + 主 Agent 汇总  
   - 模块：Subagent Depth  
   - 依赖：`agent-subagent-depth-limit`；建议在 `agent-context-window-v2` 之后（并行更吃上下文）  
   - 状态：planned  
   - 契约：4.4  

## 6. 排期思路

**技术依赖序（推荐默认）：**

```
agent-plan-persist          ──最小闭环（Plan 可回放）
agent-context-window-v2
agent-resilience-playbook   （可与 window-v2 并行）
agent-context-vector-recall
agent-subagent-depth-limit
agent-subagent-write
agent-multi-agent-fanout
```

三条产品线可交错：若你更想先打「子代理深度」，可在 `context-window-v2` 之后优先 `subagent-depth-limit`，向量召回后移。  
**技术依赖外的优先级由你拍板。**

## 7. 观察项

- 现有 `AssistantTaskRail` 与「Plan 持久化侧栏」的信息架构是否合并为一块，避免双轨
- message 级 embedding 存独立表还是列扩展：实现时再定，契约只要求可召回
- 是否单独开 Langfuse roadmap
- 写子代理是否允许 `admin` 域：默认否，需要时 roadmap update

## 8. 变更日志

- 2026-07-10：新建本 roadmap，承接一期三块深度缺口（计划/韧性、上下文、子代理）。
