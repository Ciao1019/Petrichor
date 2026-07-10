---
doc_type: feature-acceptance
feature: 2026-07-10-agent-confirm-write
status: accepted
summary: 确认协议 + content_write 最小写/危险工具已接线；危险不对模型暴露；壳 ApprovalCard 回传
---

# agent-confirm-write acceptance

## 结论

通过。契约 4.4 一期最低面已落地。

## 证据

- `confirmation.test.ts`：白名单、装载排除 dangerous、确认执行、消息 patch、拒绝对调
- `tools/index.test.ts`：content_write 装载集与提示纪律
- `chat-handler`：pending confirmation → executeConfirmedDangerousAction → executionOutcome
- 壳：`ConfirmationToolUI` + `ApprovalCard` + `addResult`
- `architecture/runtime-assistant.md` 已更新

## 未做（符合 design）

- admin 危险项、folder/kb/bulk 删除、移动重命名、独立确认表
