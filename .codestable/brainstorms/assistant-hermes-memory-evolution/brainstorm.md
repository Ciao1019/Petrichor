---
doc_type: brainstorm
slug: assistant-hermes-memory-evolution
created: 2026-07-17
status: active
summary: 对齐 Hermes 的多层记忆 + 可写 Skills + 手动触发的离线进化；一期仅服务 userId=1 超管，不解决多租户偏好/Skills 冲突
tags: [assistant, memory, skills, self-evolution, hermes, roadmap-ready]
---

# Assistant 多层记忆与自我进化（Hermes 对齐）

> 创意空间 | 2026-07-17 | roadmap 已落盘：`roadmap/assistant-operator-memory-evolution/`；下一步可起子 feature `operator-persistent-memory`

## 出发点

想要类似 [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) 的能力：用得越久越懂操作者、越会复用已验证流程，并能用执行轨迹离线优化 skill/prompt——不是改模型权重，也不是只「存聊天记录」。

调研要点（已对齐口径）：

- Hermes「自我进化」= 可持久化文本层（记忆短文 + Skills）+ 离线 GEPA/DSPy 优化这些文本；**不训权重**
- 四层刻意分家：会话上下文 / 情景档案检索 / 常驻短文 / 程序性 Skills
- 工程纪律比 Honcho/GEPA 本身更值钱：硬字数上限、冻结快照保 prompt cache、Skills 渐进披露、写入审批门闩、外部 memory provider 最多一个

与现状差距：

- 已有：线程内压缩、向量召回雏形、静态 4 个 skill + `load_skill` 渐进披露
- 缺口：跨会话常驻记忆（`agent-memory-runtime` 已 cancelled）、跨线程情景检索产品化、可写 Skills、离线进化
- 愿景冲突：2026-07-10 曾拍板取消跨会话记忆蒸馏；「都做」需显式重开 requirement，不能伪装成旧 cancelled 项微调

## 聊过的方向

### 产品范围

- **A 只要跨会话记得住我 / B 只要可写 Skills / C 只要离线进化** → 用户要 **都做**
- 规模判断：多 feature 子系统 → case 4 先 grill 存 brainstorm，再 `cs-roadmap`

### 归属主体

- A 每登录用户一套 / B 按知识库空间共享 / C 用户级+空间级双轨 / **D 先只做用户级**
- 后续修正：**不做多用户偏好与 Skills 冲突**——产品虽是 SaaS，本能力只服务 `userId = 1` 超级管理员；一般无其他用户。按单操作员建模（更接近 Hermes 本机代理）

### 写入信任

- A 默认可写可关 / B 一律暂存确认 / **C 记忆可自动写；Skills 创建与大改必须审批** / D agent 只读

### 常驻记忆形态

- **A Hermes 式两块短文（用户画像 + 环境/约定）+ 硬字数上限 + 会话开始冻结注入**
- B 旧 `PREFERENCE|TOPIC|FACT` 蒸馏条目 + embedding
- C 短文+条目混合 / D 先短文后条目 → 否决 B/C/D 作为一期主路径

### 情景检索

- 用户选 C（FTS + embedding），且 **一期两个都做**，不砍其中一个到二期

### 离线进化

- **A 完全手动触发 → diff/PR 式提案 → 人工合并**
- B 定时跑仍只提案 / C 达标自动合入 / D 一期只打轨迹基建 → 否决自动合入；一期就要有可触发的进化提案面，不是空基建

## 当前倾向

倾向于 **Hermes 对齐的四层记忆 + 可写 Skills + 手动离线进化**，一期只服务超管（id=1）：

1. **常驻层**：两块短文、硬上限、冻结快照注入；agent 可自动策展写入
2. **情景层**：跨线程 FTS + embedding 语义召回，按需工具取回再摘要
3. **Skills 层**：在现有目录/`load_skill` 上增加 create/patch；创建与大改走审批
4. **进化层**：手动触发，读轨迹产出提案，人工合并；不自动写生产
5. **明确不做（一期）**：多租户记忆隔离产品化、空间共享 Skills、Honcho 类外部画像、权重训练、进化自动合入

## 已敲定的点

| 点 | 状态 |
|----|------|
| 目标栈：常驻短文 + 情景检索(FTS+embedding) + 可写 Skills + 手动离线进化，一期都要 | 已确认 |
| 服务对象：仅 `userId = 1` 超管；不为普通用户做偏好/Skills 冲突处理 | 已确认 |
| 记忆写入：可自动写（类 Hermes memory tool / nudge） | 已确认 |
| Skills 写入：创建与大改需审批；日常小 patch 策略留给 roadmap 细化 | 已确认 |
| 常驻形态：两块短文 + 硬字数上限 + 会话开始冻结快照（本轮写入影响下一会话） | 已确认 |
| 情景召回：一期同时做 FTS 与 embedding | 已确认 |
| 离线进化：手动触发 → 提案/diff → 人工合并；不自动合入 | 已确认 |
| 归属叙事：单操作员，不做空间级共享记忆/Skills（后置） | 已确认 |
| 须重开愿景：推翻/补充「取消跨会话记忆蒸馏」的旧裁决 | 已确认 |
| 旧表 `petrichor_agent_memory*`：复用、迁移还是新表旁路 | 留给 roadmap |
| GEPA/DSPy 是否原样引入 vs 自研轻量变异评测 | 留给 roadmap |
| Skills 落盘位置：DB vs 仓库文件 vs 对象存储 | 留给 roadmap |

## 遗留问题 & 下一步

### 最大未知

1. **与 cancelled `agent-memory-runtime` 的关系**：新开 roadmap/requirement，还是复活并改写旧项？
2. **旧记忆表与蒸馏管道**：废弃蒸馏、只保留表壳，还是迁移进短文模型？
3. **冻结快照与现有 system prompt / Mastra 前缀缓存**：如何在 Next.js 请求模型下等价实现 Hermes 的 session-start snapshot
4. **进化评测集从哪来**：人工用例、历史成功轨迹、还是 LLM-as-judge rubric？
5. **Skills 审批 UI**：复用危险确认卡，还是独立「待合并 skill」抽屉？

### 建议 roadmap 注意

- 先 `cs-req draft` 写清「超管个人副驾驶记忆与进化」愿景，避免和已 cancelled 记忆项打架
- 模块建议切四块（可调）：常驻记忆运行时 / 跨线程情景检索 / 可写 Skills+审批 / 手动离线进化
- 依赖顺序倾向：常驻注入 → 情景检索工具 → 可写 Skills → 进化（进化依赖轨迹与 skill 可写）
- 单操作员约束应写进接口契约（所有写 API 校验超管 id=1），避免后续误做成多租户
- 不要把 Honcho、多平台 Gateway、权重 RL 塞进同一 roadmap

### 下一步

准备好了就触发 **`cs-roadmap`**（会读本文件）。若愿景要先落稳，可先 **`cs-req draft`**。
