# 如何按本 roadmap 实施（给 Claude Code / 其他 Agent）

> 操作说明，不是契约。接口与模块边界以 `chat-first-universal-agent-roadmap.md` 第 3、4 节为准。

## 必读材料（每次开干前）

1. `.codestable/attention.md`
2. `.codestable/requirements/chat-first-universal-agent.md`
3. 本目录 `chat-first-universal-agent-roadmap.md`（尤其第 3、4 节）
4. 本目录 `chat-first-universal-agent-items.yaml`（当前进度与依赖）

## 铁律

1. **一次只做一条** `items.yaml` 里的子 feature；做完验收后再开下一条。
2. **依赖未完成禁止开工**：目标条目必须 `status: planned`，且 `depends_on` 全部为 `done`。
3. **roadmap 第 4 节是硬约束**：不能在 design / 实现里偷偷改 API、工具名、表结构、确认协议。要改 → 先停下来走 `cs-roadmap update`。
4. **站内 API 用 `/api/assistant/**`**；**禁止改动**对外 `/api/agent/**`、MCP、Skill、API Key 产品线。
5. **保留**知识库 / 文档库等手动 CRUD 页面；退役分散 QA / 记忆主入口只属于 `agent-legacy-retire`。
6. **阶段门禁**：`cs-feat-design` → 等人确认 → `cs-feat-impl` → `cs-feat-accept`。未放行不要写业务代码。
7. **`agent-runtime-core` 不要走 fastforward**（跨模块 + 契约重）。后续小条可在用户明确要求时用 `cs-feat-ff`。

## 推荐顺序

| 顺序 | slug | 说明 |
|------|------|------|
| 1 | `agent-runtime-core` | 统一对话 / 线程 / 域注册 / 意图路由骨架 |
| 2 | `agent-tools-readonly` | 知识库 / 文档库 / 系统只读工具 |
| 3 | `agent-chat-shell` | Chat-first 壳；**最小闭环** |
| 4 | `agent-memory-runtime` | 可与 plan 并行（仅依赖 runtime） |
| 5 | `agent-plan-resilience` | 规划 UI + 韧性 |
| 6 | `agent-confirm-write` | 确认协议 + 内容写入 |
| 7 | `agent-tools-admin` | 管理面工具 |
| 8 | `agent-legacy-retire` | 拆旧 QA / 记忆入口 |
| 9 | `agent-subagents-compress` | 二期；非一期门闩 |

技术依赖外的优先级由用户口头指定时，仍不得违反 `depends_on`。

## 开一条子 feature 的标准流程

### A. 设计（`cs-feat-design`）

对 Agent 说（或粘贴）：

```text
按 cs-feat-design，从 roadmap 起头做 chat-first-universal-agent 里的 {SLUG}。

硬约束：
1. 先读 .codestable/attention.md
2. 必读本 roadmap 主文档第 3、4 节与 items.yaml
3. 必读 requirements/chat-first-universal-agent.md
4. 第 4 节接口契约是硬约束；冲突则停并建议 cs-roadmap update
5. design frontmatter 必须带：
   roadmap: chat-first-universal-agent
   roadmap_item: {SLUG}
6. 用户批准 design 后回写 items.yaml：status=in-progress，feature=目录名
7. 本轮只产出 design + checklist，等确认后再实现
```

把 `{SLUG}` 换成例如 `agent-runtime-core`。

### B. 实现（`cs-feat-impl`）

用户明确批准 design 后：

```text
按 cs-feat-impl 实现已 approved 的 {SLUG}。
严格按 checklist 推进；不要扩大到下一条 roadmap 条目；
不要改 /api/agent/**；不要动知识库/文档库手动 CRUD 主流程（除非本条 checklist 明确要求）。
```

### C. 验收（`cs-feat-accept`）

```text
按 cs-feat-accept 验收 {SLUG}。
对照 design 与 roadmap 第 4 节契约核对；
通过后回写 items.yaml 为 done，并同步主文档清单状态。
```

## 新会话「总控」提示（可选）

```text
你在实施 .codestable/roadmap/chat-first-universal-agent/。
先读 HOW-TO-IMPLEMENT.md，再读 roadmap 第 3、4 节与 items.yaml。
一次只做 depends_on 已全部 done 且 status=planned 的下一条；
每条走 cs-feat-design → 等我确认 → cs-feat-impl → cs-feat-accept。
站内 API 用 /api/assistant/**；禁止动 /api/agent/**。
现在从下一条可开工的条目开始，先 cs-feat-design。
```

## 最小闭环验收标准（记住）

`agent-chat-shell` 完成后，登录用户应能在**一个对话**里：

- 问「有多少个知识库」类系统元信息（`list_system_overview` 等）
- 检索并阅读知识库内容
- 检索并阅读文档库内容

在此之前不要做 `agent-legacy-retire`（避免把旧入口重定向到未就绪的壳）。

## 常见错误

- 说「把通用 Agent 做完」导致一次改多条、绕过契约
- 在 feature 里私自改工具名 / 表名 / 确认协议
- 依赖未完成就开 write / admin / legacy
- 把对外 MCP 工具和站内 assistant 工具混在同一套路由里改
- 删掉知识库 / 文档库手动页面（违反 req 边界）

## 相关路径速查

| 文件 | 用途 |
|------|------|
| `chat-first-universal-agent-roadmap.md` | 模块 + 接口契约 + 清单 |
| `chat-first-universal-agent-items.yaml` | 机器可读进度 |
| `../../requirements/chat-first-universal-agent.md` | 愿景与边界 |
| `../../brainstorms/chat-first-universal-agent/brainstorm.md` | 决策背景 |
