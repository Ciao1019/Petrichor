---
doc_type: feature-acceptance
feature: 2026-07-10-agent-subagent-depth-limit
status: accepted
summary: depth/maxDepth 与有限再委派已落地；越界 soft-fail；单测 8 通过
---

# agent-subagent-depth-limit acceptance

对照 design：默认 maxDepth=1；allowRespawn；越界 `subagent_depth_exceeded`；硬上限 2。roadmap → done。
