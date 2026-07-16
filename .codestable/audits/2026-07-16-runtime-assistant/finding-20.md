---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "maintainability-04"
nature: maintainability
severity: P2
confidence: high
suggested_action: cs-refactor
status: fixed
---

# Finding 20：消息明文抽取逻辑双份拷贝

## 速答

`context-pack.extractMessagePlainText` 与 `context-recall.extractPlainTextForRecall` 实质相同。

## 关键证据

- `context-pack.ts:115-138`
- `context-recall.ts:17-40`

## 影响

摘要与召回规则只改一边会不一致。

## 修复方向

抽到共享 `message-text.ts`。

## 建议动作

`cs-refactor`。
