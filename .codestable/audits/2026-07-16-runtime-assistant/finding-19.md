---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "maintainability-03"
nature: maintainability
severity: P1
confidence: high
suggested_action: cs-refactor
status: fixed
---

# Finding 19：research / write 子代理实现大块重复

## 速答

`research-subagent.ts` 与 `write-subagent.ts` 几乎同构的 Agent 创建、超时 race、step 记录与工具黑名单。

## 关键证据

- `research-subagent.ts:121-267` vs `write-subagent.ts:150-266` — 同构骨架
- 两侧各维护 `BLOCKED_*_TOOLS` 字符串集合

## 影响

改超时/韧性/step 需双改，易漂移。

## 修复方向

抽公共 `runNestedAgent`；分叉只保留只读汇总 vs 写提案。

## 建议动作

`cs-refactor`。
