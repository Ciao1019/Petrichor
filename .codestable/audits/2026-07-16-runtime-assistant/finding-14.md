---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "performance-03"
nature: performance
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 14：向量召回在对话热路径同步补 embedding

## 速答

`ensureThreadMessageEmbeddingsBestEffort` 每轮可读最多 200 条消息、扫 embedding 表，再逐条 INSERT；挂在 `buildContextPack` 热路径上。

## 关键证据

- `context-recall.ts:152-161` — `select` 线程消息 `limit(200)` 并 `JSON.parse`
- `context-recall.ts:182+` — 查已有 embedding 后批 embed，循环写库
- `context-pack.ts` — 每轮可触发上述 ensure

## 影响

缺 embedding 的长线程：延迟 + embedding API + DB 写放大；架构称「可选/失败跳过」，成功路径成本很高。

## 修复方向

后台异步补齐；热路径只读已有向量。

## 建议动作

`cs-issue`，涉及行为与调度边界，需单独设计。
