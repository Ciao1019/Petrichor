---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "bug-04"
nature: bug
severity: P2
confidence: medium
suggested_action: cs-issue
status: open
---

# Finding 07：afterToolCall 固定 input:{} 且 stepIndex 非原子

## 速答

工具审计步骤永远记空 input；并行 tool call 时 `stepIndex++` 可能撞号/乱序。

## 关键证据

- `apps/web/src/server/assistant/chat-handler.ts:323-347` — `input: {}`，`stepIndex: stepIndex++`
- `apps/web/src/server/assistant/tools/research-subagent.ts:209-213` — 子代理同样 `input: {}`

## 影响

排障无法还原工具入参；并行时 step 序号不可靠（取决于 Mastra 是否并行调度）。

## 修复方向

传入真实 tool input；stepIndex 用 DB 序列或锁。

## 建议动作

`cs-issue`（审计完整性）或并入确认协议修复。
