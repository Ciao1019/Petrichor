---
doc_type: audit-finding
audit: 2026-07-16-runtime-assistant
finding_id: "maintainability-01"
nature: maintainability
severity: P1
confidence: high
suggested_action: cs-refactor
status: fixed
---

# Finding 17：AssistantChatPage 巨石模块（~2785 行）

## 速答

对话壳单文件近 2800 行，页面状态机、Transport、ToolUI、侧栏等堆在一起，远超可维护阈值。

## 关键证据

- `AssistantChatPage.tsx` — `wc -l` ≈ 2785
- 同文件内含线程加载、确认删除、模型/焦点、十余个内联 UI 组件

## 影响

改一处易牵全局；评审/测试成本高，与「薄壳」预期偏离。

## 修复方向

按 Transport / ToolUI / 线程列表 / 页面容器拆分。

## 建议动作

`cs-refactor`，行为不变的结构拆分。
