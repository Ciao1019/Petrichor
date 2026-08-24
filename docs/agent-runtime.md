# Agent Runtime

Petrichor 的站内助手不再是「先做意图分类，再执行固定工具集」的流程机器，
而是一个持续决策的 Agent Runtime：用户给目标，Main Agent 自己决定需要什么信息、
需要哪些能力、是否拆分子任务、什么时候停止。

代码位置：`apps/web/src/server/assistant/agent-runtime/`

## 主循环

```text
User Goal
  ↓
复杂度识别（规则，无额外 LLM 调用）
  ↓
可选 Plan（仅 complex）
  ↓
┌─ 推理段（Mastra agent.stream，内部可多次工具调用）
│    ↓
│  ToolExecutor：权限 → 校验 → 确认 → 超时 → 重试
│    ↓
│  Observation + Evidence + Trace + LoopDetector
│    ↓
│  StopPolicy 裁决
│    ↓
│  需要新能力？→ load_skill → 中止本段，带新工具重开一段
└─ 产出文本 → 结束
  ↓
证据不足以直接作答时：强制收敛段（无工具，只基于 Evidence 作答）
```

底层 tool calling loop 复用 Mastra（`mastra-bridge.ts`），Runtime 只补充
State / Plan / Observation / Evidence / Skill / Delegation / Context /
StopPolicy / LoopDetection / Trace / Budget。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `runtime.ts` | 编排主循环，唯一顶层 orchestrator |
| `state.ts` | 可序列化 `AgentState`，支持快照/恢复 |
| `planner.ts` | 规则复杂度识别、计划推进 |
| `context-manager.ts` | 每轮上下文组装与 token 预算分区 |
| `observation.ts` | 工具结果 → 紧凑观察（含错误观察） |
| `evidence.ts` | 证据存储、去重、质量与新鲜度打分 |
| `tool-registry.ts` | 统一工具注册表（namespace + 元数据） |
| `tool-executor.ts` | 唯一工具执行入口 |
| `skill-registry.ts` / `skill-loader.ts` | 能力目录与动态加载 |
| `delegation.ts` / `subagent-runtime.ts` | 委派编排与子代理执行 |
| `stop-policy.ts` / `loop-detector.ts` / `budget.ts` | 停止裁决、循环检测、预算 |
| `trace.ts` / `store.ts` | Trace 收集（含脱敏）与持久化 |
| `events.ts` / `chat-bridge.ts` | 流式事件协议与聊天流桥接 |
| `eval.ts` | Run 级与检索级指标 |
| `prompts/` | 拆分后的 prompt，每个能力一份 |

## 复杂度与预算

| 复杂度 | 判定 | 迭代 | 工具调用 | 子代理 |
| --- | --- | --- | --- | --- |
| `direct` | 寒暄 / 常识 / 纯计算 | 1 | 0 | 0 |
| `simple` | 单步检索足够 | 4 | 4 | 0 |
| `multi_step` | 需要多轮检索与动态决策 | 12 | 14 | 2 |
| `complex` | 多子任务 / 比较 / 综合分析 / 需要外部研究 | 24 | 32 | 5 |

复杂度只影响预算与是否生成计划，**不限制** Agent 能加载哪些能力。

## 停止与循环

`StopPolicy` 在每轮推理前与每次工具调用后裁决，命中即收敛去作答（不是硬中断）：

- 预算类：`max_iterations` / `max_tool_calls` / `max_execution_time` / `max_tokens`
- 循环类：完全重复、A→B→A→B 模式、重复检索（query 近似且结果指纹不变）
- 进展类：连续 N 次工具调用没有新增证据 → `no_progress`

面向用户的文案由 `describeStopReasonForUser` 统一转换，内部策略名只出现在 Debug 通道。

## 数据库迁移

新增表与 BM25 索引列在 `docs/migrations/2026-08-18-agent-runtime-v2.sql`，
并已登记到 `docs/migrations/manifest.json`。Vercel production 部署会在构建前自动执行；
本地或紧急情况下也可以手动执行：

```bash
DATABASE_URL=... bun db:run-sql docs/migrations/2026-08-18-agent-runtime-v2.sql
```

未执行时 Runtime 仍能正常回答（持久化层读写都 fail-open），但会失去：
Trace/Evidence 落库、刷新恢复执行面板、Debug 页面数据。
日志会带 `code: 42P01` 与该跑哪个迁移的提示。

全新安装走 `bun db:sql` 生成的初始化 SQL，其中已包含这些表与列。

## Feature Flag

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AGENT_RUNTIME_V2` | `true` | 关闭后 chat-handler 回落到 `chat-handler-legacy.ts` |
| `SOFT_ROUTER_ENABLED` | `true` | 关闭后完全不跑 Router |
| `AGENT_DYNAMIC_SKILLS` | `true` | 关闭后 `load_skill` 直接返回失败 |
| `AGENT_DELEGATION` | `true` | 关闭后不允许委派 |
| `RAG_BM25` / `RAG_RRF` / `RAG_RERANK_ENABLED` | `true`/`true`/`false` | 检索管线开关 |
| `AGENT_DEBUG` | `false` | 非操作员访问 Trace 接口的开关 |

预算与超时也可用环境变量覆盖，见 `config.ts`。

## 长会话

`conversation-summary.ts` 维护结构化摘要（goals / decisions / importantFacts / unresolvedQuestions），
并注入 ContextManager 的「会话背景」分区。触发有门槛：轮次 < 12 或转录 token < 6000 直接跳过，
简单请求不会因此多一次 LLM 调用。摘要失败返回 null，主流程不受影响。

## 已知限制

- 不做后台异步执行：`AgentState` 支持快照/恢复，但没有 resume 调度器；
  刷新时仍在运行的 Run 通过 `agent-run/detail` 轮询恢复，而不是重新订阅事件流。
- Planner 使用规则草案计划，Agent 通过 `agent.update_plan` 改写；
  没有独立的 planner 模型调用（§83 明确不为省成本强行拆模型）。
- Retrieval Eval 的 Recall@K / MRR 需要标注集才有值，当前只产出各路召回贡献度。
