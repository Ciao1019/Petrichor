---
doc_type: feature-acceptance
feature: 2026-07-10-agent-context-window-v2
status: accepted
summary: 动态最近窗口 windowPolicy 已接入 ContextPack；单测覆盖三 reason
---

# agent-context-window-v2 acceptance

对照 design：`resolveRecentWindowPolicy` 覆盖 fixed / token_budget / turn_budget；`buildContextPack` 始终返回 `windowPolicy`；无向量召回、无新迁移。

roadmap `agent-context-window-v2` → done。
