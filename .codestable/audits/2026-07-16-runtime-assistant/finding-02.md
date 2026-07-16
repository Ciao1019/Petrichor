---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "security-02"
nature: security
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 02：确认无服务端一次性消费，可重放

## 速答

消费态只靠客户端 messages 上的 `executionOutcome`；重放「已确认且无 outcome」的同一 payload 会再次执行。

## 关键证据

- `apps/web/src/server/assistant/confirmation.ts:123-125` — `confirmed` 且 `executionOutcome === undefined` 即视为待执行
- `apps/web/src/server/assistant/confirmation.ts:140-160` — `patchConfirmationExecutionOutcome` 只改内存中的 messages，不写服务端确认表
- `apps/web/src/server/assistant/chat-handler.ts:153-155` — 每轮请求只要扫到 pending 就执行

## 影响

网络重试、客户端 bug、恶意重放可重复执行；对 `set_public_qa_enabled` 可反复切换站点开关（超管会话下）。

## 修复方向

服务端 confirmationId 单次消费（原子 update / 已用标记）。

## 建议动作

`cs-issue`，与 finding-01 同批修确认协议。
