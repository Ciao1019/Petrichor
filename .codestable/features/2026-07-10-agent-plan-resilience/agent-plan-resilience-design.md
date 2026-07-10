---
doc_type: feature-design
feature: 2026-07-10-agent-plan-resilience
requirement: chat-first-universal-agent
roadmap: chat-first-universal-agent
roadmap_item: agent-plan-resilience
status: approved
summary: 落实契约 4.7——消息内 Plan 卡 + 工具超时 30s / 同名连续失败耗尽 / 流中断约定
tags: [agent, assistant, plan, resilience]
---

# agent-plan-resilience design

## 0. 术语约定

| 术语 | 定义 | 防冲突结论 |
|------|------|-----------|
| Plan 卡 | 壳内 `PlanToolUI` 渲染 `upsert_plan` | 已接线；本条不加 sticky 侧栏（拍板 A） |
| 工具超时 | execute 超过 **30s** → FAILED + `tool_timeout` | 拍板 A |
| 重试耗尽 | 本 run 同名连续失败 ≥2 → 短路 `tool_retry_exhausted` | 契约 4.7 |
| 流中断 | 读流失败 → run FAILED + `stream_aborted` | 已有，本条核对 |

## 1. 决策与约束

**需求摘要**：Plan 在对话内可见；工具失败有纪律；流中断正确落库。

**已拍板（2026-07-10）**：Plan 仅消息内卡（A）；超时 30s（A）。

**关键决策**：韧性落 `tool-resilience.ts`；`step.error_code` 加列；连续失败中间 COMPLETED 清零；不新建 Plan 表。

**明确不做**：sticky 侧栏、Plan 表、记忆、确认写入、Langfuse、改 `/api/agent/**`。

## 2. 名词与编排

### 2.1 名词层

**变化**：`petrichor_assistant_step.error_code`；`createToolResilienceController`；`recordAssistantStep` 透传 errorCode。

### 2.2 编排层

同名连败≥2 短路 → 否则 race(30s) → 记 step → 模型可换招；流中断 → stream_aborted。

### 2.3 挂载点

1. error_code 列 + recordAssistantStep  
2. tool-resilience 接入 Mastra 装载  
3. 系统提示「工具失败可换招」

### 2.4 推进策略

1. 迁移 → 2. 包装+单测 → 3. 流中断/提示 → 4. Plan 回归 → 5. 收尾  

### 2.5 结构健康度

新增 `tool-resilience.ts`；不做目录重组。

## 3. 验收契约

1. upsert_plan → Plan 卡  
2. 连败 2 次后再调 → tool_retry_exhausted  
3. >30s → tool_timeout  
4. 流中断 → stream_aborted  
5. 换招成功 → 后续可 COMPLETED  

反向：无 Plan 表 / sticky；upsert_plan 名不变。

## 4. 架构

更新 `runtime-assistant.md`。
