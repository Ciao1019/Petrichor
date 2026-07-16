---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "performance-05"
nature: performance
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 16：Fanout×子代理成本叠加且超时不取消底层任务

## 速答

`spawn_research_fanout` 并行最多 3 个子代理，各自 `maxSteps=6`、超时约 90s；`Promise.race` 超时只 reject，不 abort 底层 generate。

## 关键证据

- `research-fanout.ts` — `Promise.all` 并行 ≤3
- `research-subagent.ts` — 独立 Agent.generate + 超时 race
- `tool-resilience.ts` — raceWithTimeout 同类「只竞速不取消」模式

## 影响

最坏 3× 嵌套工具/LLM 并发打满配额；超时后工作仍跑，浪费连接与费用。

## 修复方向

AbortSignal 贯通；全局并发/预算上限。

## 建议动作

`cs-issue`，需明确取消语义与配额策略。
