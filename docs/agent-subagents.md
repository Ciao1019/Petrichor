# Agent SubAgents

`agent.delegate` 把彼此独立的子任务交给子代理并行执行，
统一走 `SubAgentRuntime` + `DelegationManager`。

## 什么时候用

- 需要分别研究多个主题（例如同时调研三个产品）；
- 某个子任务需要独立上下文、步骤较多，混在主线里会污染上下文；
- 可并行且结果彼此不依赖。

## 什么时候不要用

- 一次搜索、一次读节点；
- 简单问答；
- 子任务之间强依赖（后一步要用前一步结果）——那是主 Agent 自己该做的多轮推理。

`complexity` 为 `direct` / `simple` 时 Runtime 会直接拒绝委派。

## 安全约束

- **深度**：`maxDelegationDepth` 默认 2，硬上限 2；
- **工具范围**：请求 ∩ 用户有权使用 ∩ `allowedInSubAgent`；
  未指定 `skillIds` / `allowedToolIds` 时只给一组只读检索工具，
  绝不默认继承主 Agent 全部工具；
- **副作用**：默认不给子代理副作用工具，除非调用方显式点名；
- **提权**：主 Agent 没有的权限，子代理一定拿不到（`intersectToolScope` + PermissionResolver 双重把关）。

> 注意「父级可用工具」指的是**权限层面**的可用集合，而不是主 Agent 当前已解锁的工具。
> 主 Agent 本来就能自己 `load_skill("research")`，因此把 research 子任务委派出去不构成提权。

## 上下文隔离

子代理只拿到：Objective + 必要背景 + 相关证据 Top-N + 授权工具，
不会复制主 Agent 的完整对话。

## 返回

子代理必须返回结构化 Evidence，而不是一段没有来源的总结。
若只产出文字结论，Runtime 会把结论本身降级成一条 `subagent` 证据（confidence 较低），
保证主 Agent 至少能追溯到「这是子代理说的」。

失败不会拖垮主流程：已收集的部分证据一并交回，主 Agent 自行决定是否补做。
