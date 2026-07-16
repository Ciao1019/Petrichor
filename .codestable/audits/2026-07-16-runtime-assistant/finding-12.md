---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "performance-01"
nature: performance
severity: P1
confidence: high
suggested_action: cs-refactor
status: fixed
---

# Finding 12：SSE 开流后首 token 前串行阻塞过久

## 速答

`assistantChat` 的 SSE `execute` 内依次 await 意图 LLM、压缩探测、context pack（含摘要/召回），才进入 `agent.stream`，用户长时间只见「识别/整理」而无正文。

## 关键证据

- `chat-handler.ts:219` — `await routeAssistantIntentWithLlm(...)`（可长达数秒）
- `chat-handler.ts:249-269` — 其后 `inspectContextCompressNeed` + `buildContextPack`
- `chat-handler.ts:294+` — 再 `agent.stream`；架构写「开 SSE → compress → pack → stream」，但正文 TTFB 被前置全部阻塞

## 影响

长线程、低置信度意图、需刷新摘要时首包延迟明显；体感像卡住。

## 修复方向

意图/压缩与首 token 流水线化或并行化；压缩中 UI 与正文流解耦。

## 建议动作

`cs-refactor`，因为是热路径结构调整，行为可保持一致。
