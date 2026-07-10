---
doc_type: feature-acceptance
feature: 2026-07-10-agent-tools-admin
status: accepted
summary: admin 域 8 工具已注册；危险项走确认；admin 路由辅助 content_write；超管校验公开问答开关
---

# agent-tools-admin acceptance

## 结论

通过。

## 证据

- `admin.test.ts`：装载排除 dangerous、白名单、拒绝对调、提示、默认域不含 admin
- `intent-router.test.ts`：admin 意图含 content_write
- `tools/admin.ts` + `confirmation.ts` 白名单扩展
- `runtime-assistant.md` 已更新

## 未做（符合 design）

- 对话内创建 AI 配置 / Agent Key
- 全量编辑 baseUrl/model
