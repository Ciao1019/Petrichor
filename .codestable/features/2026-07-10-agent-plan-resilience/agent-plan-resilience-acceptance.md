---
doc_type: feature-acceptance
feature: 2026-07-10-agent-plan-resilience
status: accepted
summary: 工具韧性（30s 超时 / 同名连败耗尽 / step.error_code）已接线；Plan 仍仅消息内卡；流中断 stream_aborted 保留
---

# agent-plan-resilience acceptance

## 结论

通过。契约 4.7 一期最低面已落地。

## 证据

- `tool-resilience.test.ts`：timeout / retry_exhausted / streak 清零
- 本地库已执行 `2026-07-10-assistant-step-error-code.sql`
- `chat-handler`：resilience 装载、afterToolCall 写 errorCode、stream_aborted、换招提示
- Plan：壳内既有 `PlanToolUI`，本条未加 sticky
- `architecture/runtime-assistant.md` 已更新

## 未做（符合 design）

- sticky Plan 侧栏、独立 Plan 表
