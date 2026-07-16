---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "security-03"
nature: security
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 03：确认执行路径把 API Key 明文写入 steps

## 速答

`update_ai_config_credentials` 确认后，`recordAssistantStep` 把含明文 `apiKey` 的 input 写入 `assistant_steps`。

## 关键证据

- `apps/web/src/server/assistant/chat-handler.ts:161-166` — `input: pendingConfirmation.action.input` 原样落库
- `apps/web/src/server/assistant/tools/admin.ts:32-36` — schema 含 `apiKey: z.string().trim().min(1)`
- `apps/web/src/server/assistant/thread-logic.ts:200-204` — `inputJson: JSON.stringify(input.input)` 无脱敏

## 影响

明文密钥进入步骤审计表，扩大泄露面（备份、日志、越权读 steps、内部排障导出）。配置表本身是加密存储，此处绕过了该保护。

## 修复方向

落库前按工具脱敏（apiKey → redacted），或确认路径不记录敏感字段。

## 建议动作

`cs-issue`，敏感数据落库。
