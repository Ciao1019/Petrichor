---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "security-01"
nature: security
severity: P0
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 01：确认态可客户端伪造，绕过确认协议

## 速答

危险工具执行完全依据请求体里的 assistant tool parts；攻击者可伪造 `confirmed:true` + `action`，跳过确认 UI 直接执行删文/吊销 Key 等。

## 关键证据

- `apps/web/src/server/assistant/chat-handler.ts:151-155` — `findPendingConfirmationExecution(messagesForModel)` 后直接 `executeConfirmedDangerousAction`，messages 来自客户端 `input.messages`
- `apps/web/src/server/assistant/confirmation.ts:109-134` — 只校验 zod 形状与白名单映射，不对照服务端已签发的确认记录
- `apps/web/src/features/pages/assistant/AssistantChatPage.tsx:205-207` — UI 仅 `addResult({ confirmed: true, confirmationId })`；服务端却信任同消息里的 `args.action`

## 影响

已登录用户（或 XSS/恶意客户端）可对自有资源绕过「危险操作须确认」控制面。跨用户仍受工具内 ownership 约束，但确认协议本身失效。

## 修复方向

服务端签发确认 token（落库/签名），执行时校验 thread/user/tool/input 指纹且一次性消费。

## 建议动作

`cs-issue`，因为属于确认安全控制失效。
