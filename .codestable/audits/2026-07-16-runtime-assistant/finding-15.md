---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "performance-04"
nature: performance
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 15：线程详情与水位计算无分页全量加载消息

## 速答

`getAssistantThreadDetail` 一次拉齐全部消息；context pack 水位相关查询也无 limit 扫 id；前端 `loadThread` 整包 hydrate。

## 关键证据

- `thread-logic.ts:258-262` — detail 无 limit 拉 `assistantMessages`
- `AssistantChatPage.tsx` — `loadThread` 全量塞入 runtime（约 761 行一带）
- `context-pack.ts` — `listRecentPersistedMessageIds` / watermark 相关全量 id 扫描

## 影响

长对话冷启动与压缩水位 O(消息数)；内存与首屏随历史线性恶化。

## 修复方向

消息分页/游标；水位用 SQL 聚合或有界窗口。

## 建议动作

`cs-issue`，需改 API 契约与壳加载策略。
