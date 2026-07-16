---
doc_type: feature-ff-note
feature: move-article-cross-kb
date: 2026-07-16
requirement:
tags: [assistant, content_write, knowledge-base]
---

## 做了什么
给站内助手补上 `move_article`，支持把文章跨知识库（也兼容同库）移动到目标库/文件夹。

## 改了哪些
- `apps/web/src/server/kb/article-move-logic.ts` — 同库排序/跨库归属迁移（含 wiki 衍生数据）
- `apps/web/src/server/assistant/tools/content-write.ts` — 注册 `move_article`
- `write-subagent.ts` / `research-subagent.ts` / `skills/index.ts` — 白名单与 playbook
- 相关单测与 `runtime-assistant.md` 一句现状更新

## 怎么验证的
跑了 `index.test.ts`、`write-subagent.test.ts`、`skills/index.test.ts`、`knowledge-base-node-move.test.ts`（20 passed）。

## 顺手发现（可选，不阻塞）
- Agent MCP 的 `move_article` 仍仅同库；未在本次扩展
