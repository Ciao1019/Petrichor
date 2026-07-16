---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "maintainability-02"
nature: maintainability
severity: P1
confidence: high
suggested_action: cs-refactor
status: fixed
---

# Finding 18：assistantChat 上帝函数职责过重

## 速答

`assistantChat`（约 106–398 行）串联确认执行、SSE、意图、压缩、pack、Agent、持久化，圈复杂度与耦合过高。

## 关键证据

- `chat-handler.ts:106-398` — 单函数覆盖整条流水线
- 架构流水线清晰，代码未按阶段拆模块

## 影响

性能/安全改动必须碰同一函数，回归面大。

## 修复方向

按阶段拆：confirm → intent → context → stream → persist。

## 建议动作

`cs-refactor`。
