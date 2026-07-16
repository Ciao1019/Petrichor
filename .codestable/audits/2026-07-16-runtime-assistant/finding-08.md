---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "bug-05"
nature: bug
severity: P2
confidence: medium
suggested_action: cs-refactor
status: open
---

# Finding 08：parseAssistantFocus 无 schema 校验的类型断言

## 速答

DB 中 `focusJson` 解析后直接 `as AssistantFocus`，畸形数据会进入后续 focus 使用路径。

## 关键证据

- `apps/web/src/server/assistant/thread-logic.ts:52-58` — `parsed as AssistantFocus`，失败仅 catch JSON 语法错误
- 对比：`assistantFocusSchema`（同文件 27-32）写路径有 zod，读路径未复用

## 影响

脏 focus 可能导致工具默认上下文异常；`assertAssistantFocusOwnership` 只在请求 focus 上跑，线程内存 focus 展示/冷启动可能带脏字段。

## 修复方向

读路径 `assistantFocusSchema.safeParse`，失败返回 null。

## 建议动作

`cs-refactor`。
