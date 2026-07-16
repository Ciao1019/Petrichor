---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "performance-02"
nature: performance
severity: P1
confidence: high
suggested_action: cs-refactor
status: fixed
---

# Finding 13：同轮重复执行 context 压缩探测与打包

## 速答

每轮先 `inspectContextCompressNeed` 再 `buildContextPack`，二者各自解析窗口策略、查 thread、数消息，造成双倍 DB/计算。

## 关键证据

- `chat-handler.ts:249-269` — 先 inspect 再 build
- `context-pack.ts` — 两函数内部均含 `resolveRecentWindowPolicy` / thread select / message count 同类逻辑

## 影响

每轮对话固定多付一轮查询；长线程放大延迟。

## 修复方向

合并为单次 pack，用中间态驱动「压缩中」UI。

## 建议动作

`cs-refactor`，局部去重即可。
