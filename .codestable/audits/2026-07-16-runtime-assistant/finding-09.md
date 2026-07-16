---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "arch-01"
nature: arch-drift
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 09：意图路由无域数量上限，可一次装载全站非 dangerous 工具

## 速答

架构要求「禁止一次挂载全站 tools」；规则路由返回所有得分域，LLM schema 无 max，可同时装载 knowledge+doc+system+content_write+admin。

## 关键证据

- `.codestable/architecture/runtime-assistant.md` 已知约束：「禁止一次挂载全站 tools；默认三读域不含 admin/content_write」
- `apps/web/src/server/assistant/intent-router.ts:46-54` — 所有 scored domains 全量进入结果
- `apps/web/src/server/assistant/intent-llm.ts:31-34` — `domains` 仅 `min(1)`，无上限
- `apps/web/src/server/assistant/chat-handler.ts:236` — `loadMastraToolsForDomains(finalRoute.domains, …)` 按返回域全量装载（dangerous 仍排除）

## 影响

弱匹配（如「分享」）或 LLM 过宽分类时，本轮直接暴露 create/update/share/set_default 等写工具，扩大误写面。

## 修复方向

域集合 top-k / 互斥策略；LLM schema 加 max；默认拒绝无写意图时装载 content_write/admin。

## 建议动作

`cs-issue`。
