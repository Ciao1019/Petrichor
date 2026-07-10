---
doc_type: feature-acceptance
feature: 2026-07-10-agent-chat-shell
roadmap: chat-first-universal-agent
roadmap_item: agent-chat-shell
status: accepted
summary: Chat-first 壳以 KnowledgeQa Grok UI 为基座接通 /api/assistant/*，完成最小闭环
last_reviewed: 2026-07-10
---

# agent-chat-shell acceptance

## 结论

通过。登录后默认进入 `/dashboard/assistant`，复用原知识问答的流式交互与侧栏体验，后端走统一 Assistant 运行时与 12 个只读工具。

## 纠偏

原 design 以通用 `thread.tsx` 薄壳实现会丢失流式/工具卡体验；实现改为以 `KnowledgeQaPage` Grok UI 为基座改接 assistant API。共享 `thread.tsx` 文案改动已回滚。旧 `/dashboard/qa` 零 diff。

## 证据摘要

- 路由：`/dashboard` → `/dashboard/assistant`；`/dashboard/metrics` 保留数据概览
- Transport：`POST /api/assistant/chat`，响应头 `X-Petrichor-Assistant-Thread-Id`
- 焦点三态：全部 / 知识库 / 文档库，随每轮 `focus` 发送
- Tool UI：12 锁名工具（overview/list/search/read/citations/progress/table/plan/artifact）
- `tsc` 通过；后端零 diff（本条未改 server/api，除既有 assistant 后端）

## 未做（归后续条目）

- 记忆注入 / 蒸馏 → agent-memory-runtime
- 韧性深做 → agent-plan-resilience
- 写入确认 → agent-confirm-write
- 拆旧 QA 入口 → agent-legacy-retire
