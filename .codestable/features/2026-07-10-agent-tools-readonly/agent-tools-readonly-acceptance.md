---
doc_type: feature-acceptance
feature: 2026-07-10-agent-tools-readonly
status: passed
summary: agent-tools-readonly 验收通过——12 个锁名工具、三域装载、辅助 system 域与域感知提示均按契约落地，10 条场景有证据
tags: [agent, assistant, tools, acceptance]
---

# agent-tools-readonly 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-10
> 关联方案 doc：`agent-tools-readonly-design.md`（status: approved）

## 1. 接口契约核对

**接口示例逐项核对**（design 2.1 vs 代码）：

- [x] `search_knowledge`（`tools/knowledge.ts`）：输入 `query + knowledgeBaseId?`，省略库时先用 focus、再无则跨库；输出 `mode + hits[]`，树命中含 `nodeKey/title/snippet/articleId/href`，跨库命中额外保留 `knowledgeBaseId/knowledgeBaseName`
- [x] `read_knowledge_node`（`tools/knowledge.ts`）：`nodeKey | pageKey | articleId` 必须且只能提供一个，分别分发到树节点 / Wiki 页 / 源文章 reader，统一返回 `kind + contentMd + href`
- [x] `list_system_overview`（`tools/system.ts`）：返回 knowledgeBases/articles/docLibraries/documents/assistantThreads 五项计数及 chatModelReady/embeddingModelReady；实现为六个轻量查询，未引用 `loadDashboardOverview`
- [x] `upsert_plan`（`tools/system.ts`）：直接用现有 `SerializablePlanSchema` 校验并回显，状态仅允许 pending/in_progress/completed/cancelled；`done` 单测拒绝，无持久化逻辑

**12 个锁名工具逐项核对**（roadmap 4.3）：

| domain | 工具 | risk |
|---|---|---|
| knowledge | `list_knowledge_bases`, `search_knowledge`, `read_knowledge_node` | 全部 read |
| doc_library | `list_doc_libraries`, `search_documents`, `read_document` | 全部 read |
| system | `list_system_overview`, `show_progress`, `show_citations`, `show_data_table`, `upsert_plan` | read |
| system | `save_answer_artifact` | write |

- [x] 名称与域和 4.3 表恰好相等：12 个，不多不少；`tools/index.test.ts` 同时断言注册数组与三域装载后的 ToolSet
- [x] risk 契约：仅 `save_answer_artifact=write`，其余 11 个均为 read

**名词层“现状 → 变化”核对**：

- [x] assistant 注册表由空集变为三域 12 工具，全部新注册文件位于 `src/server/assistant/tools/`
- [x] UI 回显工具复用现有 citation/data-table/plan/progress-tracker schema，没有另造协议
- [x] `petrichor_assistant_artifact` 从仅建表变为由 `save_answer_artifact` 写入 kind/title/content_json/thread_id/run_id

**流程图核对**（design 2.2）：

- [x] 模块加载：`chat-handler.ts` side-effect import `./tools` → `tools/index.ts` 按三域调用 `registerAssistantTools`
- [x] 每轮对话：`routeAssistantIntent` 补辅助域 → 同一 `route.domains` 传给 `createAssistantRun`、`loadToolsForDomains` 与 `buildAssistantSystemPrompt` → `streamText` 工具循环 → `recordAssistantStep`

无未处理接口偏差。

## 2. 行为与决策核对

**需求摘要逐项验证**：

- [x] 系统概览可读真实用户计数并落 COMPLETED step
- [x] 知识库可检索→阅读→引用；SQLite/无向量能力时保留关键词结果
- [x] 文档库可检索定位→按 fromIndex 翻页→引用
- [x] 全程沿用 runtime-core 的 run/step 持久化，没有新增前端或另一条对话链路

**明确不做逐项核对**：

- [x] `propose_wiki_patch`：`rg` assistant 目录零命中
- [x] 无 content_write/admin **工具注册**：`tools/*.ts` 注册项零命中；intent-router 中既有写入/管理意图模式仍保留，仅用于路由，不是工具注册
- [x] 未移植 `deep_research_kbs` 或任何子代理工具
- [x] 无前端改动：`git status -- src/components client-app.tsx dashboard-routes.ts` 零命中
- [x] 未改 `/api/agent/**`、旧 `app/api/kb/agent/chat`、旧 `app/api/doc-library/chat`
- [x] 本 feature 未新增 `app/api/**` 路由、表或 migration；当前工作树中的 `/api/assistant/**` 与 schema/full-migration 变更属于前置 `agent-runtime-core` 的未提交资产，按交接基线保留

**关键决策落地**：

- [x] D1：12 个锁名工具一次注册，含 `upsert_plan` 与 `save_answer_artifact`
- [x] D2：`search_knowledge` 有库时树检索 + 语义增强，无库时跨库；语义异常只把 mode 降为 tree
- [x] D3：`read_knowledge_node` 三选一统一寻址
- [x] D4：`list_system_overview` 独立轻量查询，不复用重型 dashboard overview
- [x] D5：三个 `show_*` UI 工具与 `upsert_plan` 只做 schema 校验/回显；Plan 状态使用 `completed`
- [x] D6：artifact 是唯一 write risk
- [x] D7：系统提示按本轮域生成，明确先检索、再阅读、给引用、不得编造
- [x] D8：knowledge/doc_library → system 的合并只在 intent-router 一处完成；纯 system 不扩域，也不自动加入 content_write/admin

**编排层与流程级约束核对**：

- [x] `intent_domains_json` 与工具装载使用同一 `route.domains`：`chat-handler.ts` 分别在 createAssistantRun/loadToolsForDomains 直接传同一变量，无二次集合加工
- [x] 工具错误由 AI SDK 产出 tool-error，`onToolExecutionEnd` 落 FAILED step；集成测试证实 SSE 继续、assistant message 落库、run 最终 COMPLETED
- [x] 归属隔离：包装层始终传 `ctx.userId`；底层 KB/文档库查询按 userId/owner 校验；另一用户的库在集成测试中不可见
- [x] focus 仅作为缺省范围：显式 knowledgeBaseId/libraryId/documentId 优先，底层仍做归属校验
- [x] 体积上限：树检索片段 1600 字符、知识检索 ≤12 条、文档检索 ≤20 条、read_document 单次 ≤40 chunks
- [x] 每次工具调用记录 tool_name/input/output/status/duration_ms，step_index 单调递增

**挂载点反向核对（可卸载性）**：

- [x] M1：`src/server/assistant/tools/` 三域注册包与测试
- [x] M2：`chat-handler.ts` 的 `import "./tools"`
- [x] M3：`chat-handler.ts` 的 `buildAssistantSystemPrompt(route.domains)` 域感知提示
- [x] M4：`intent-router.ts` 的 `withSystemAuxiliaryDomain`
- [x] 反向 grep：业务代码中的 feature 引用均落在 M1–M4；未发现额外挂载点
- [x] 拔除沙盘：删除 M1、移除 M2、还原 M3、移除 M4 后，runtime-core 回到空注册表 + 原路由域集合；无表/路由/前端残留需要清理

## 3. 验收场景核对

主要证据来自 Node 24 + SQLite 的 `tools/chat-handler.integration.test.ts`，并由域包单测补齐 schema/降级边界：

| # | 场景 | 证据 | 结果 |
|---|---|---|---|
| S1 | 问“我有多少个知识库” | 实际执行 `list_system_overview`；输出 knowledgeBases=1；step=COMPLETED | 通过 |
| S2 | focus 知识库检索→阅读→引用 | run domains=`[knowledge,system]`；三步依次 COMPLETED；citation href 为 dashboard 路径 | 通过 |
| S3 | 无 focus 跨库检索 | `mode=cross_kb`，命中含 knowledgeBaseId + knowledgeBaseName | 通过 |
| S4 | 文档检索与翻页 | search 命中 p.2；read_document 从 fromIndex=1 续读并返回定位 | 通过 |
| S5 | 两个列表工具归属隔离 | 数据库同时存在另一用户库，两个输出都只含当前用户 1 条 | 通过 |
| S6 | 保存回答产物 | artifact 真实落行，kind/title/content_json/thread_id/run_id 一致 | 通过 |
| S7 | `upsert_plan` 形状 | 现有 Plan schema 可解析 completed/in_progress；`done` 被拒绝 | 通过 |
| S8 | SQLite/语义不可用降级 | focus 知识集成链实际返回 `mode=tree` 与关键词命中；单测覆盖语义异常 | 通过 |
| S9 | 假 documentId | step=FAILED；SSE 后续文本继续；assistant message 落库；run=COMPLETED | 通过 |
| S10 | run 域集合与 step 工具 | run 保存 knowledge+system / doc_library+system；实际 step 均属于对应装载域；代码确认落库与装载共用 `route.domains` | 通过 |

额外补强：带 `focus.libraryId + focus.documentId` 的文档问答已实测 domains=`[doc_library,system]`，并实际执行 `search_documents → read_document → show_citations` 三步，不只停留在路由单测。

本 feature 零前端改动，无需浏览器验收；UI schema 只做服务端工具输出契约复用，真正渲染接线留给 agent-chat-shell。

## 4. 术语一致性

- 锁名工具：代码注册名与 roadmap 4.3 的 12 个 snake_case 名称逐字一致 ✓
- 域：仅 knowledge / doc_library / system 出现在工具注册中；content_write/admin 只存在于 runtime 路由枚举/意图识别，不构成注册 ✓
- 辅助域：代码、design、roadmap 4.2 都使用“knowledge/doc_library 命中时附带 system”的同一语义 ✓
- Plan 状态：roadmap 4.7、组件 schema、工具测试均为 `completed`，无 `done` 兼容分支 ✓
- 防冲突：assistant 模块无 `propose_wiki_patch`，未复用旧栈 Mastra 内联工具注册状态 ✓

## 5. 架构归并

- [x] `architecture/runtime-assistant.md`：frontmatter 增加本 feature；当前状态改为三域 12 工具已就绪；结构与交互补工具包、辅助域、域感知提示；数据与状态补 artifact 写入与 step 实际状态；已知约束补降级、归属、体积、错误继续语义
- [x] `architecture/ARCHITECTURE.md`：索引一句话同步为“按域查系统概览、检索知识库与文档库”
- [x] 无新子系统，不新增 architecture 文档

归并后，只读 architecture 即可知道 12 工具的存在、三域装载方式、辅助 system 域与核心边界。

## 6. requirement 回写

`requirement: chat-first-universal-agent` 当前仍为 `status: draft`，本次**按用户明确约束保持 draft，文件不改**。

理由：本条完成的是后端只读工具能力，用户可感的“打开应用就是对话”主入口尚未由 `agent-chat-shell` 交付。升级门槛明确为 agent-chat-shell 完成最小闭环；届时再把 requirement 升为 current，并按实际主入口刷新 implemented_by/变更日志。当前愿景、用户故事与边界均未改变。

## 7. roadmap 回写

- [x] `chat-first-universal-agent-items.yaml`：核对 `agent-tools-readonly` 原状态 in-progress、feature=`2026-07-10-agent-tools-readonly`，现已改为 done，并记录 2026-07-10 验收通过
- [x] 主 roadmap 第 5 节第 2 条同步为 done（2026-07-10 验收），对应 feature 路径已补齐
- [x] 未启动下一条 `agent-chat-shell`，其状态仍为 planned、feature 仍为 null
- [x] items YAML 校验通过

## 8. attention.md 候选盘点

有 1 条环境候选，**本次未写入 attention.md**；按约束等待用户确认后再走 `cs-note`：

> SQLite 集成测试需使用与 `better-sqlite3` 原生模块 ABI 一致的 Node 24；当前默认 Node 22 会因 ABI 不匹配跳过相关测试。

证据：Node 24（modules ABI 137）Assistant 套件 51/51 通过；默认 Node 22 执行同套件时 43 通过、8 个 SQLite handler 集成用例按条件跳过。

## 9. 遗留

**本条不修的观察项**：

- `server/kb/wiki-tree.ts` 的 SQLite 关键词回退按空格拆词；中文完整问句通常会成为单一长 term，召回稳定性不足。本 feature 的集成证据使用可稳定命中的短关键词“部署/回滚”，不能证明任意中文整句检索质量。

**按 roadmap 留给后续 feature 的能力**：

- 无前端 assistant 壳与 Tool UI 渲染接线（agent-chat-shell）
- `upsert_plan` 无持久化、展示、超时/重试耗尽策略（agent-plan-resilience）
- artifact 暂无读取/展示入口
- 无 content_write/admin 工具与危险确认（agent-confirm-write / agent-tools-admin）

**验证汇总**：

- Node 24 Assistant 定向 Vitest：8 files / 51 tests 全通过
- 默认 Node 22 Assistant 定向 Vitest：7 files 通过、1 file 跳过；43 tests 通过、8 SQLite tests 跳过
- TypeScript：`pnpm --filter @petrichor/web typecheck` 通过
- 定向 ESLint：`eslint src/server/assistant` 通过；全仓 lint 首次在 Node 24 默认约 4GB 堆上 OOM，未发现 lint 诊断，未把环境 OOM 视为功能回归
- Production build：Node 24 + 8GB heap 下 `next build` 通过，166 个静态页面生成完成
- 全仓 Vitest：366 通过、2 个既有失败；失败仍为 `spring-text-encryptor` Java fixture 解密与 `s3-delete` 批量删除断言，均不在本 feature 作用域

无未处理验收偏差；等待用户终审与是否提交的决定。
