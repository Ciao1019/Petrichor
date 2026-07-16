---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "maintainability-05"
nature: maintainability
severity: P2
confidence: medium
suggested_action: cs-refactor
status: open
---

# Finding 21：预算常量与工具黑名单散落、无单一真相源

## 速答

上下文 token 预算、压缩阈值、子代理黑名单以魔法数字/字面量散落多文件，与 registry 无联动。

## 关键证据

- `chat-handler.ts` — `MAX_CONTEXT_TOKENS = 100_000`
- `context-pack.ts` — `MESSAGE_COUNT_TRIGGER` / `TOKEN_BUDGET_RATIO` / 摘要截断长度
- `research-subagent.ts` / `write-subagent.ts` — 黑名单字面量与注册表名耦合

## 影响

增删工具或调预算易漏改；难与真实模型窗口对齐。

## 修复方向

集中配置；黑名单由 registry risk/域推导。

## 建议动作

`cs-refactor`。
