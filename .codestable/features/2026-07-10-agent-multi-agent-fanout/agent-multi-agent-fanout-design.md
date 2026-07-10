---
doc_type: feature-design
feature: 2026-07-10-agent-multi-agent-fanout
requirement: chat-first-universal-agent
roadmap: assistant-runtime-depth
roadmap_item: agent-multi-agent-fanout
status: approved
summary: 新增 spawn_research_fanout，同 run 并行 ≤3 个只读研究子代理并返回分结果；主助手汇总；无团队 DSL
tags: [agent, assistant, subagent, fanout]
---

# agent-multi-agent-fanout design

## 0. 术语约定

| 术语 | 定义 | 防冲突结论 |
|------|------|-----------|
| spawn_research_fanout | 并行只读委派入口 | 本 feature 锁定名 |
| tasks | 1..3 条子任务 `{goal, domains, focus?}` | 契约 ≤3 |
| 无团队 DSL | 不持久化团队定义/编排图 | 契约明确不做 |

## 1. 决策与约束

**默认**：`Promise.all` 并行调用既有 `spawnResearchSubagent`；子任务 `maxDepth=0`（fanout 内不再嵌套）；超时沿用单子代理；结果数组回主助手汇总。

**不做**：写 fanout；>3 任务；编排引擎；子代理内再 fanout。

## 2. 名词与编排

```
input: { tasks: [{ goal, domains, focus? }] }  // 1..3
output: { ok, results: SpawnResearchResult[], usage: { tasks, calls, totalTokens } }
```

## 3. 验收

1. system 域可调用 fanout  
2. tasks 长度 0 或 >3 校验失败  
3. 并行返回与 tasks 等长 results  
4. 子代理/写子代理不装载 fanout  
5. 无团队表/DSL  

## 4. 架构

更新 runtime-assistant；roadmap 本条 done。
