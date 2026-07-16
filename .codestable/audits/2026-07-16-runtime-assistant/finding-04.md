---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "bug-01"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 04：确认续跑时可能把 assistant 消息当 user 持久化

## 速答

`lastUserText` 从历史任意 user 消息提取，但持久化内容固定取 `messages.at(-1)`；确认续跑时末条常为 assistant，会以 `role:"user"` 写入错误内容。

## 关键证据

- `apps/web/src/server/assistant/chat-handler.ts:114` — `extractLastUserText(input.messages)` 向前回溯
- `apps/web/src/server/assistant/chat-handler.ts:122-128` — `if (lastUserText)` 则 `role: "user", content: input.messages.at(-1)`
- `apps/web/src/features/pages/assistant/AssistantChatPage.tsx:205-207` — 确认只 `addResult`，典型续跑不会追加新的 user 文本消息

## 影响

线程消息历史污染（user 行存 assistant/tool parts）、标题被反复刷新、上下文压缩/召回读到脏数据。

## 修复方向

仅当 `messages.at(-1).role === "user"` 时才持久化 user；或显式找最后一条 user 消息对象。

## 建议动作

`cs-issue`。
