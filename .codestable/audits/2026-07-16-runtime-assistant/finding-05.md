---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "bug-02"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 05：delete_article 多表删除无事务

## 速答

标签/分享/文章/节点分四次独立 delete，中途失败会留下孤儿或半删状态。

## 关键证据

- `apps/web/src/server/assistant/tools/content-write.ts:188-196` — 连续四次 `db.delete`，assistant 树内无 `db.transaction`
- 同目录 grep：`apps/web/src/server/assistant/**` 无 transaction 使用

## 影响

部分成功时树节点/文章不一致，后续 read/list 异常，需手工修库。

## 修复方向

包进单事务，或复用知识库已有原子删除逻辑。

## 建议动作

`cs-issue`。
