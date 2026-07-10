---
doc_type: feature-acceptance
feature: 2026-07-10-agent-runtime-core
status: passed
summary: agent-runtime-core 验收通过——契约 4.1/4.2/4.3/4.5 全落地，11 条场景全有证据，架构/req/roadmap 已回写
tags: [agent, assistant, runtime, acceptance]
---

# agent-runtime-core 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-10
> 关联方案 doc：`agent-runtime-core-design.md`（status: approved）

## 1. 接口契约核对

**接口示例逐项核对**（design 2.1 vs 代码）：

- [x] `POST /api/assistant/chat`（`src/server/assistant/chat-handler.ts` `assistantChat`）：请求 `{ threadId?, messages, configId?, focus? }` → SSE UIMessage 流 + `X-Petrichor-Assistant-Thread-Id/Run-Id` 双头；实测一致（e2e 抓包）
- [x] `POST /api/assistant/thread/list`：`{ limit, q }` → `{ items, nextCursor }`；实测返回键名为契约要求的 `items`（非旧栈 `threads`）
- [x] 错误路径 401/400/403/404/409 全部实测命中，形状 `{ code, msg, path, timestamp }`

**名词层"现状 → 变化"逐项核对**：

- [x] 5 张 `petrichor_assistant_*` 表：`schema.ts:827-885` + `full-migration.ts:1021` 起，列与契约 4.5 逐列一致（focus_json 按假设 A 为 text；migration 测试断言覆盖）
- [x] `AgentDomainId` / `IntentRouteResult` / `AssistantToolRegistration`（`domain-types.ts`）与契约 4.2/4.3 一致；`ZodTypeAny`→`z.ZodType`（zod v4 等价，design 2.1 注脚已记）
- [x] `AssistantToolContext = { userId, threadId, runId, focus }` 按 design 定义落地
- [x] 注册表 API：`registerAssistantTools`（同名抛错）/ `loadToolsForDomains(domains, ctx)`（假设 B 已获批）
- [x] `routeAssistantIntent`：`recentToolNames` 由 `listRecentToolNames` 从最近 run 的 steps 取，符合 design

**流程图核对**（design 2.2 mermaid）：

- [x] 图中 A→N 全部节点在 `chat-handler.ts` 有实际落点：鉴权:44 / 校验:45 / focus:49 / thread:52 / user msg:60 / 模型(409):69 / 路由:72 / run:73 / 装载:86 / streamText:98 / step:109 / finish:123-129 / assistant msg:139

无偏差。

## 2. 行为与决策核对

**需求摘要逐项验证**：

- [x] 登录用户在新端点完成一轮纯 LLM 流式对话并全程落库 → e2e 实测（真实模型，thread/message/run 落库，run=COMPLETED）
- [x] 注册表与路由器可被下一条直接消费 → 类型导出 + 12 个单测锁定行为

**明确不做逐项核对**（反向核对项，全部 grep 实证）：

- [x] `app/api/agent/**` 零改动（git status 零命中）
- [x] 无业务工具注册：`loadToolsForDomains` 空注册表返回 `{}`（单测）；assistant 模块 `propose_wiki_patch` 零命中
- [x] 两条旧 chat 路由零 diff
- [x] 无旧表迁移代码：assistant 模块内 `petrichor_kb_agent|petrichor_doc_qa|knowledgeBaseAgent|docQa` 零命中
- [x] 无前端改动：`client-app.tsx`、`dashboard-routes.ts` 零 diff
- [x] 4.4 确认协议 / 4.6 记忆 / 4.7 重试降级未实现，仅留列与挂钩位（grep 无相关实现代码）

**关键决策落地**：

- [x] D1 AI SDK `streamText`（非 Mastra）：`chat-handler.ts` 无任何 `@mastra` import
- [x] D2 规则启发式路由：`intent-router.ts` 纯打分函数，零网络调用
- [x] D3 软删：`softDeleteAssistantThread(s)` 置 `deleted_at`；e2e 验证行保留、list/detail 过滤
- [x] D4 configType=CHAT + 409 转译：`resolveAssistantModel` 将 400/404 转 `HttpError(409)`，不改 `generation.ts`
- [x] D5 错误形状复用 `toErrorResponse`：实测 5 种错误码全为 `{ code: number, msg, path, timestamp }`

**编排层变化核对**：

- [x] 每轮先路由后装载（chat-handler.ts:72→86 顺序固定）；路由结果落 `run.intent_domains_json`（e2e 查库证实）
- [x] 5 条 thread 薄路由 re-export handler，与仓库既有惯例一致

**流程级约束核对**：

- [x] user msg 先于流持久化（:60 早于 :98）；assistant msg 在 `toUIMessageStream.onEnd` 以完整 parts 落库（e2e detail 可见 tool/text parts 结构）
- [x] run 不遗留 RUNNING：`finishRunOnce` 幂等守卫 + onEnd/onError/onAbort 三路兜底；abort 实测 FAILED/`stream_aborted`
- [x] step 按 `step_index` 递增、`duration_ms` 由 onToolExecutionStart/End 计时（本期空工具集，接线就绪，行为由下一条 feature 实际触发）

**挂载点反向核对（可卸载性）**：

- [x] M1 `app/api/assistant/**` 6 条路由 — 与清单一致
- [x] M2 `petrichor_assistant_*` schema 段 + migration DDL 段 — 与清单一致
- [x] M3 `src/server/assistant/` 目录 — 与清单一致
- [x] **反向 grep**：`server/assistant` 的仓内引用只有 6 条路由文件；表符号只被 schema 自身 + assistant 模块引用；`petrichor_assistant` 字面量只在 schema/migration(+test)
- [x] **拔除沙盘推演**：删 M1+M2+M3 后仓内零残留引用（`full-migration.test.ts` 新增断言块随 M2 一起删，属 M2 附属）

## 3. 验收场景核对

全部在隔离环境实测（独立 sqlite + `PETRICHOR_DESKTOP` 免登录 + 真实模型；401 场景另起无免登录实例）：

| # | 场景 | 证据 | 结果 |
|---|------|------|------|
| S1 | 新对话流式返回 | SSE text-delta 流；双响应头；run=COMPLETED + `intent_domains_json=["system","knowledge","doc_library"]`；user+assistant msg 落库 | 通过 |
| S2 | threadId 复用 | thread 总数不变、消息 2→4、updated_at 前移 | 通过 |
| S3 | 本人 focus | 200 + `focus_json` 落库 | 通过 |
| S4 | list 分页/搜索 | `items`+`nextCursor:2`；`q=手动` 命中 | 通过 |
| S5 | create/detail/delete/delete-many | 契约形状；软删后 detail 404、list 排除、行保留；`{deleted:2}` | 通过 |
| S6 | messages 空 | 400 JSON | 通过 |
| S7 | 他人/不存在 threadId | 404 | 通过 |
| S8 | 非本人 focus | 403 且未创建 thread（前后计数相等） | 通过 |
| S9 | 未登录 | chat 与 thread API 均 401 | 通过 |
| S10 | 无 CHAT 配置 | 409 且未创建 run | 通过 |
| S11 | 流中途 abort | run=FAILED + `error_code=stream_aborted`，消息保留 | 通过 |

前端无改动，无需浏览器验证（e2e 本身即 HTTP 层实测）。测试套件：assistant 相关 22 个单测 + migration 断言全绿；全仓 2 个存量失败（crypto/s3）经 stash 复测证实与本次无关。

## 4. 术语一致性

- `assistant` 前缀贯穿：表 `petrichor_assistant_*`、模块 `src/server/assistant/`、头 `X-Petrichor-Assistant-*` — grep 全一致 ✓
- 契约锁定符号 `routeAssistantIntent` / `registerAssistantTools` / `loadToolsForDomains` 仅在 assistant 模块定义与使用，无别名 ✓
- 防冲突：assistant 模块内 `X-Petrichor-Agent` 零命中；与对外 Agent 产品线（`/api/agent/**`）无交叉引用 ✓

## 5. 架构归并

`architecture/` 此前不存在，本次初建骨架并实际写入：

- [x] `architecture/ARCHITECTURE.md`（新建）：子系统索引 + 三条关键架构决定（站内/对外分离、AI SDK 选型、契约由 roadmap 锁定）
- [x] `architecture/runtime-assistant.md`（新建）：名词（5 表 + 注册表/路由契约）← design 2.1；动词骨架（chat pipeline + thread API）← design 2.2；已知约束（禁全站挂载、错误语义、软删、扩展点）← design 2.2 流程级约束
- 存量子系统（KB/文档库/认证/对外 Agent）未 backfill——超出本 feature 范围，roadmap 观察项已记，建议后续 `cs-arch backfill`

## 6. requirement 回写

`requirement: chat-first-universal-agent`（status: draft）。**保持 draft 不升级**：该 req 的用户可感能力（对话主入口查事/办事）要到 `agent-chat-shell` 最小闭环才成立，本条只交付运行时底座，用户视角无新能力。愿景与边界均未变化，无需刷新。

## 7. roadmap 回写

- [x] `chat-first-universal-agent-items.yaml`：`agent-runtime-core` 核对原状态 `in-progress` + feature 目录一致 → 改 `status: done` + notes 记验收日期；`validate-yaml.py` 校验通过
- [x] 主文档第 5 节第 1 条同步：状态 done（2026-07-10 验收）+ 对应 feature 目录

## 8. attention.md 候选盘点

- 候选 1（已落）：Next 16 同目录禁起第二个 dev server —— 用户已确认，`cs-note` 已写入「运行与本地起服务」
- 候选 2（待用户定）：`PETRICHOR_DESKTOP=true` + `DATABASE_URL=file:...` 可起免登录的隔离全栈实例（sqlite 首连自动建表），适合 e2e 自测
- 候选 3（待用户定）：全仓 vitest 有 2 个存量环境相关失败（`spring-text-encryptor`、`s3-delete` 各 1 例），非回归信号，勿因此回滚改动

## 9. 遗留

- **顺手发现**（不在本次范围）：
  - 两条旧 chat 路由约 200 行 usage/token 辅助函数字面重复（design 2.5 已记）→ 建议随 `agent-legacy-retire` 自然消亡或 `cs-refactor`
- **已知限制**：
  - `petrichor_assistant_artifact` 本期仅建表无读写（`save_answer_artifact` 属 agent-tools-readonly）
  - message 表无 content_text 列（契约如此），thread 搜索仅覆盖标题
  - thread 标题随最新一条用户消息更新（与旧栈同款行为）
  - usage/token 统计元数据未持久化，留给 chat shell 按需决定
