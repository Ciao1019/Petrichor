---
doc_type: brainstorm
slug: chat-first-universal-agent
created: 2026-07-10
status: active
summary: 把分散的 KB/文档库 QA 与半成品能力收成 Chat-first 全站通用 Agent（可执行+危险确认），一期先做意图路由/记忆/规划/韧性
tags: [agent, chat-first, mastra, knowledge-base, doc-library, roadmap-ready]
---

# Chat-first 全站通用 Agent

> 创意空间 | 2026-07-10 | 下一步：按 roadmap 启动子 feature（req + roadmap 已落盘）

## 出发点

触发点不是「把知识库问答再打磨一轮」，而是对现有 Agent 产品面的否定性判断：

- Wiki 补丁审批进 QA、引用专属 UI、文档库语义对齐等优化，感觉**都没啥用**
- 现有能力散落在 KB QA / 文档库 QA / Agent Memory / Wiki 补丁等入口，半成品感强
- 真正想要的是：**一个对话界面，能查看系统里的事、也能做系统里的事**——知识库问答只是其中一种意图

真问题：缺少「系统副驾驶」主入口与成熟运行时；继续在旧 QA 产品上打补丁会继续堆半成品。

## 聊过的方向

### 候选 A：继续强化知识库问答产品

补丁审批闭环、引用质量检测、文档库向量对齐 KB。

- 否决：用户明确觉得当前 Wiki 补丁与相关优化「没啥用」，问题不在局部 UX

### 候选 B：研究型 Agent（问资料为主，范围扩到 KB+文档库+元信息）

- 未选：范围仍偏「问答」，达不到「做任何事」

### 候选 C：运维型 Agent（编译/embedding/lint/定时任务为主）

- 未选：太窄，不是日常主入口

### 候选 D：Chat-first 全站通用 Agent（选定倾向）

一个对话壳兼容知识库、文档库、系统元问题与管理操作；内含意图识别、记忆、上下文压缩、韧性、规划与任务、子代理与团队——按成熟度分期落地。

## 当前倾向

**倾向于 Chat-first 全站通用 Agent**，核心是：

1. 主界面就是对话；列表/设置等业务面降级为上下文抽屉或次级路由
2. 写操作策略：**可执行 + 危险确认**（删、批量改、改关键配置等弹确认卡；其余在用户权限内直接做）
3. 能力范围叙事与 v1 都按**接近全站**：知识检索/问答、内容 CRUD、AI 配置、Agent Key/MCP、复盘、公开站设置等（仍受登录用户权限约束）
4. 站内入口**激进合并**：退役 `/dashboard/qa`、文档库 QA、Agent Memory 主入口；Wiki 补丁从问答链路移除；**对外 MCP/Skill/API Key 管理保留**（另一条产品线）
5. 一期运行时门闩：**意图路由 + 记忆 + 规划/任务 + 基础韧性**；子代理与深度上下文压缩放二期

## 已敲定的点

| 点 | 状态 |
|----|------|
| 产品形态：Chat-first 壳作主入口；知识库/文档库等手动操作界面保留 | 已确认 |
| 写操作：可执行 + 危险操作确认卡 | 已确认 |
| 能力范围：接近全站（含管理面），不是只做知识问答 | 已确认 |
| 旧入口：激进合并（QA / 文档库 QA / Memory 主入口退役；Wiki 补丁移出问答） | 已确认 |
| 对外 Agent 集成（MCP/Skill/REST/审计）与站内通用 Agent 并行，不删 | 已确认 |
| 一期机制：意图识别、记忆、规划与任务、基础韧性（超时重试/工具失败降级） | 已确认 |
| 二期机制：子代理与团队、深度上下文压缩 | 已确认 |
| 底层可复用：Wiki 树检索、embedding、记忆蒸馏、Mastra/AI SDK 工具、现有业务 handlers | 倾向保留为工具，不先当产品面 |
| 不在本 brainstorm 拍板的技术选型：是否继续以 Mastra 为唯一运行时、确认卡协议、工具 registry 形态 | 留给 roadmap / design |

## 遗留问题 & 下一步

### 最大未知

1. **Chat-first 与现有 Dashboard IA 的迁移节奏**：激进合并是否允许「一个大版本切主壳」，还是需要短暂隐藏路由兼容书签/会话深链
2. **危险操作清单**：哪些算必须确认（删文章/删库/改加密相关配置/批量移动…）需要列白名单，否则确认卡会滥或漏
3. **工具面爆炸**：接近全站意味着几十上百 tools——意图路由如何分域加载，避免 context 被工具 schema 撑爆
4. **会话与多实体上下文**：对话如何绑定「当前知识库 / 当前文档 / 当前任务」，Chat-first 壳的信息架构细节
5. **与外部 MCP 的边界**：站内 Agent 是否复用同一套 capability 描述，还是两套工具面

### 建议 roadmap 注意

- 先拆「壳 + 路由 + 只读全站工具」与「可写 + 确认卡」与「旧入口拆除」三条依赖链，避免和「子代理框架」绑死
- 管理面工具单独成批，避免和检索问答缠在同一 feature
- 删除/下线 Wiki 补丁进 QA、独立文档库 QA、Memory 主入口时，写清数据迁移（旧 thread 是否只读归档）
- 可观测性（tracing / 工具失败率）建议作为韧性的配套，不要等全部做完再加

### 下一步

准备好后触发 **`cs-roadmap`**，它应读取本文件：

`.codestable/brainstorms/chat-first-universal-agent/brainstorm.md`

愿景已落盘：`.codestable/requirements/chat-first-universal-agent.md`（status: draft）。

路线图已落盘：`.codestable/roadmap/chat-first-universal-agent/`。

下一步：说「开始做 roadmap 里的 agent-runtime-core」走 `cs-feat-design`（或 ff）。
