---
doc_type: feature-design
feature: 2026-07-10-agent-subagent-write
requirement: chat-first-universal-agent
roadmap: assistant-runtime-depth
roadmap_item: agent-subagent-write
status: approved
summary: 新增 spawn_write_subagent（content_write/read）；子代理只读检索并 propose_write_actions，不直接写/危险/再委派；主助手按提案执行或走确认
tags: [agent, assistant, subagent, write]
---

# agent-subagent-write design

## 0. 术语约定

| 术语 | 定义 | 防冲突结论 |
|------|------|-----------|
| spawn_write_subagent | 写意图委派工具 | 契约 4.4 锁定名 |
| propose_write_actions | 子代理内局部工具，只回显提案 | 不进全局注册表 |
| proposedActions | 返回给主助手的待执行清单 | 含 risk=write\|dangerous |

## 1. 决策与约束

**默认**：子代理仅装载 knowledge/doc_library/system 只读工具 + propose_write_actions；禁止 spawn_* / 写 / 危险 / 确认卡；主助手根据提案自行 create_* 或 request_user_confirmation。

**不做**：子代理直接副作用；写子代理再委派；admin 提案；fanout。

## 2. 名词与编排

```
input: { goal, proposedActions?, focus? }
output: { ok, summary, proposedActions[{toolName,input,reason?,risk}], usage?, errorCode? }
```

## 3. 验收

1. content_write 域可调用 spawn_write_subagent  
2. 子代理工具集不含写/危险/spawn  
3. propose 只允许白名单工具名  
4. 非法提案被过滤  
5. 系统提示要求主助手确认危险项  

## 4. 架构

更新 runtime-assistant 子代理段。
