---
doc_type: feature-acceptance
feature: 2026-07-10-agent-resilience-playbook
status: accepted
summary: Playbook soft-return 与 tool_degraded / tool_circuit_open 已落地；单测 8 通过
---

# agent-resilience-playbook acceptance

对照 design：decideToolFailure 三 action；失败 soft-return；熔断不执行；超时 30s 不变。无自动代执行。

roadmap `agent-resilience-playbook` → done。
