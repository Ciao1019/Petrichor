---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "arch-03"
nature: arch-drift
severity: P2
confidence: low
suggested_action: cs-refactor
status: fixed
---

# Finding 11：public_qa.disable 映射名与可 enable 行为不一致

## 速答

工具 `set_public_qa_enabled` 可传 `enabled:true`，但白名单逻辑名固定为 `public_qa.disable`。

## 关键证据

- `apps/web/src/server/assistant/confirmation.ts:28` — `set_public_qa_enabled: "public_qa.disable"`
- `apps/web/src/server/assistant/tools/admin.ts:40-42,166-188` — schema 允许任意 boolean，执行写 `publicQaEnabled: input.enabled`
- 架构文档要求超管写开关——`requireSuperAdmin` 已满足，问题在命名/契约语义

## 影响

审计日志/契约读者会误以为只能关闭；实际开启也走同一确认路径。

## 修复方向

改名为 `public_qa.set` 或按 enabled 分映射。

## 建议动作

`cs-refactor`。
