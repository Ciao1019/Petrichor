---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "bug-03"
nature: bug
severity: P1
confidence: medium
suggested_action: cs-issue
status: fixed
---

# Finding 06：并发确认请求可重复执行危险动作

## 速答

两次并行 POST 若都携带同一 pending confirmation，都会各自 `executeConfirmedDangerousAction`，无互斥。

## 关键证据

- `apps/web/src/server/assistant/chat-handler.ts:152-155` — 请求级检测与执行，无跨请求锁
- `apps/web/src/server/assistant/confirmation.ts:123-125` — 仅看消息内 confirmed 且无 outcome
- `apps/web/src/features/pages/assistant/AssistantChatPage.tsx:205-207` — UI 有 `choice != null` 防双击，但 API 层无同等保护

## 影响

双击/重试窗口内重复删、重复吊销、重复改公开问答开关；多数第二次变 404，但开关类会翻转。

## 修复方向

与 finding-02 一并做服务端 confirmation 原子消费。

## 建议动作

`cs-issue`。
