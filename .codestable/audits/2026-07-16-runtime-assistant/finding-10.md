---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "arch-02"
nature: arch-drift
severity: P2
confidence: medium
suggested_action: cs-refactor
status: fixed
---

# Finding 10：DANGEROUS_ACTION_WHITELIST 含未实现逻辑名

## 速答

白名单声明了 `folder.delete` / `knowledge_base.delete` / `document.bulk_delete` 等，但 `DANGEROUS_TOOL_WHITELIST` 无对应工具映射。

## 关键证据

- `apps/web/src/server/assistant/confirmation.ts:5-16` — 含 folder/knowledge_base/bulk_delete
- `apps/web/src/server/assistant/confirmation.ts:21-29` — 实际映射仅 article/share/document/ai_config/agent_key/public_qa

## 影响

契约与实现漂移，后续开发易误以为已支持这些危险动作。

## 修复方向

删未实现项，或补工具与映射。

## 建议动作

`cs-refactor`。
