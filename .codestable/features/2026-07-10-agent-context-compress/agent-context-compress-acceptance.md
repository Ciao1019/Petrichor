---
doc_type: feature-acceptance
feature: 2026-07-10-agent-context-compress
status: accepted
summary: 线程级语义压缩 + TokenLimiter 硬裁剪；流内压缩中 UI；摘要失败不阻断
---

# agent-context-compress acceptance

## 结论

通过。

## 证据

- `context-pack.ts` / `context-pack.test.ts`：窗口 6、触发阈值、剥离临时 part、instructions 注入
- `chat-handler.ts`：SSE 内 `data-context-compress` → `buildContextPack` → Agent.stream；落库剥离压缩 part
- 壳：`makeAssistantDataUI({ name: "context-compress" })` + `QaPreparing`
- schema / full-migration / `docs/migrations/2026-07-10-assistant-context-summary.sql`；现有库已执行
- `runtime-assistant.md` 已回写

## 未做（符合 design）

- 无独立压缩 HTTP API
- 无跨线程记忆 / 向量召回历史
