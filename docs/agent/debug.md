# Agent Debug

## 三层信息分离

| 层 | 看到什么 | 入口 |
| --- | --- | --- |
| 普通用户 | 一行状态 + 答案 + 来源 | 聊天页执行面板（折叠态） |
| 高级用户 | 计划、聚合活动、子任务、来源 | 执行面板展开 |
| 开发者 | 原始 Tool Call、完整事件、Trace、Token、延迟 | `/assistant/agent-run/trace` |

普通 UI 永远不读 Raw Trace，也不展示模型隐藏推理。

## 页面

`/dashboard/agent/debug`（`dashboardRoutes.agentDebug`），按 Run ID 查询，支持 `?runId=` 直达。
页面分四块：Run 概要（含 token 与各段延迟）、Timeline、Tool Calls 明细、Evidence 与检索诊断。
访问受限：非操作员且未开启 `AGENT_DEBUG` 时接口返回 `agent_debug_disabled`。

## 接口

```http
POST /api/assistant/agent-run/detail   { runId }   # 安全执行视图
POST /api/assistant/agent-run/list     { conversationId, limit? }
POST /api/assistant/agent-run/trace    { runId }   # 完整 Trace，需操作员或 AGENT_DEBUG=true
```

`detail` 返回：run 状态、复杂度、计划、聚合活动、子任务、证据、指标。
其中不含 raw tool args、内部 prompt、隐藏推理与敏感 metadata。

## Trace 内容

`agent_trace_events` 按 `run_key + sequence` 有序存储，可按
runId / conversationId / userId / 时间范围 / toolId / stopReason 查询。

记录的事件类型：

```text
run_started  routing_hint  complexity_decided  plan_created  plan_updated
skill_loaded tool_call     tool_result         observation   evidence
delegation_started delegation_completed retrieval_diagnostics
final_answer stop error
```

## 脱敏

`trace.ts` 的 `redact` 在写入前处理：

- key 命中 `password|secret|token|api_key|credential|authorization|cookie|private_key` → `[redacted]`；
- 字符串超 4000 字截断，数组超 50 条截断，嵌套超 6 层截断。

不得为了调试放开这些限制。

## Eval

每次 Run 结束后 `evaluateRun` 产出指标并随 Run 落库（`eval_json`）：

```text
taskSuccess  steps  toolCalls  failedToolCalls  duplicateToolCalls
unproductiveToolCalls  evidenceCount  citationCoverage  skillLoads
routerPrecision  routerPredictedDomains  actualNamespaces
subAgentCount  subAgentUsefulCount  delegationSpeedup
loopDetected  errorRate  tokenUsage  latency
```

`routerPrecision`（预测域 vs 实际使用的工具 namespace）用于判断 Soft Router 是否还有价值。
检索侧用 `evaluateRetrieval` 统计各路召回贡献；Recall@K / MRR 需要标注集才有值。

## 前端事件流

聊天流里 `data-agent-event` part 携带结构化事件，`sequence` 单调递增，
前端 reducer 幂等且可按 sequence 重放。刷新后通过 `agent-run/detail` 恢复。

Debug 排查建议顺序：

1. `agent-run/detail` 看执行视图对不对；
2. `agent-run/trace` 看具体哪一步的参数与原始结果；
3. `retrieval_diagnostics` 事件看三路召回各自命中了什么、rerank 是否生效。
