---
doc_type: roadmap
slug: assistant-operator-memory-evolution
status: completed
created: 2026-07-17
last_reviewed: 2026-07-17
tags: [assistant, memory, skills, self-evolution, hermes]
related_requirements:
  - assistant-operator-memory-evolution
  - chat-first-universal-agent
related_architecture:
  - runtime-assistant
---

# 站内助手操作员记忆与可进化流程

## 1. 背景

站内 Assistant 已能查事办事（chat-first），但跨会话仍「健忘」：偏好要重复交代，跑通的流程留不下来，也没有人手可控的改进通道。愿景见 `requirements/assistant-operator-memory-evolution.md`；方向对齐 Hermes 的分层记忆 + 可写 Skills + 离线提案式进化（不改模型权重）。

产品虽是 SaaS，本能力按**单操作员**建模：门闩为超级管理员（经统一抽取函数，当前实现等价 `isSuperAdmin`）。不解决多用户偏好 / Skills 冲突。

上游材料：

- `.codestable/requirements/assistant-operator-memory-evolution.md`
- `.codestable/brainstorms/assistant-hermes-memory-evolution/brainstorm.md`
- `.codestable/architecture/runtime-assistant.md`

与旧裁决：`chat-first-universal-agent` 曾取消 `agent-memory-runtime`；本 roadmap **新开能力栈**，不复活旧蒸馏条目方案为主路径。

## 2. 范围与明确不做

### 本 roadmap 覆盖

- 操作员门闩（统一 `isAssistantOperator`，当前 = `isSuperAdmin`）
- 常驻短文记忆（用户画像 + 约定/笔记）+ 线程级冻结快照注入 + agent 可写
- 跨线程情景检索：关键词（FTS）+ 语义（embedding），一期都做
- 可写 Skills（create/大改审批；小 patch 可直接生效）+ 与内置 skill 目录合并渐进披露
- 手动触发的进化提案 → 人工合入

### 明确不做

- 普通用户跨会话记忆 / 多租户偏好隔离 / 空间共享 Skills
- 恢复独立「记忆」主入口页；不改 `/api/agent/**`、对外 MCP/Skill/API Key 产品线
- 改模型权重、Honcho 类外部画像、进化静默自动合入、定时无人值守进化
- 以旧 `PREFERENCE|TOPIC|FACT` 蒸馏为主路径（旧表可不 DROP，本栈不依赖）
- 多平台 Gateway、子代理团队 DSL 等无关能力

## 3. 模块拆分（概设）

```
assistant-operator-memory-evolution
├── Operator Gate + Persistent Memory：门闩、两块短文、冻结注入、memory 工具
├── Episodic Recall：跨线程 FTS + embedding 按需检索
├── Writable Skills：操作员 skill 存储、skill_manage、审批
└── Manual Evolution：手动跑提案、审 diff、合入
```

### 模块 · Operator Gate + Persistent Memory

- **职责**：判定是否操作员；持久化两块短文；按线程冻结快照注入 prompt；提供 memory 读写工具。
- **承载的子 feature**：`operator-persistent-memory`
- **触碰的现有代码 / 模块**：`chat-handler` / `system-prompt` / `context-pack` 注入链；新建 operator memory 表；不复活旧蒸馏管道。

### 模块 · Episodic Recall

- **职责**：跨线程按关键词与语义检索历史消息，经摘要后按需注入（工具结果，非整窗灌入）。
- **承载的子 feature**：`operator-episodic-recall`
- **触碰的现有代码 / 模块**：`assistant` 消息表 / embedding；新建或扩展 FTS；新工具；复用 `context-recall` 消毒逻辑。

### 模块 · Writable Skills

- **职责**：操作员可创建/patch/大改/删除流程 skill；目录进 prompt、正文 `load_skill`；create/edit/delete 走 pending 审批。
- **承载的子 feature**：`operator-writable-skills`
- **触碰的现有代码 / 模块**：`skills/`、`load-skill`、工具注册、壳侧审批 UI（对话旁路或设置抽屉）。

### 模块 · Manual Evolution

- **职责**：人手触发，基于轨迹/现 skill 生成 before/after 提案；仅人工 accept 后写入；不自动合入。
- **承载的子 feature**：`operator-evolution-manual`
- **触碰的现有代码 / 模块**：新 API + proposal 表；合入走 Skills 写路径；可引用 run/step 审计字段。

## 4. 模块间接口契约 / 共享协议

> feature-design 硬约束。要改先 `cs-roadmap update`。

### 4.0 操作员门闩（全模块共用）

**形式**：函数（本栈唯一入口）

```
isAssistantOperator(user: { id: number; systemRole: string | null | undefined }): boolean
  // 当前实现固定为：return isSuperAdmin(user.systemRole, user.id)
  // 日后若改为「仅 id=1」或其他策略，只改本函数一处

assertAssistantOperator(user): void
  // 非操作员 → 抛业务错误 → HTTP 403 code=assistant_operator_only
```

**约束**：

- 所有本栈写 API、写工具、进化触发、专属工具装载必须先过 `isAssistantOperator` / `assertAssistantOperator`
- **禁止**业务代码直接写 `userId === 1` 或散落调用 `isSuperAdmin` 充当本栈门闩
- 非操作员：不注入常驻记忆、不装载本栈专属工具；读列表类 API 可返回空集，写一律 403

### 4.1 常驻记忆存储与冻结快照

**方向**：Persistent Memory → Runtime Prompt  
**形式**：表 + 函数

```
表 petrichor_assistant_operator_profile
  user_id              bigint PK          // 操作员用户 id
  user_profile_md      text not null default ''   // 类 USER.md
  agent_notes_md       text not null default ''   // 类 MEMORY.md
  updated_at           timestamptz not null

常量（硬上限，强制策展）：
  OPERATOR_USER_PROFILE_MAX_CHARS = 1375
  OPERATOR_AGENT_NOTES_MAX_CHARS  = 2200
  // 合计不超过 3575

线程列（挂 petrichor_assistant_thread，仅操作员线程使用）：
  operator_memory_snapshot_json text null
  // { userProfileMd, agentNotesMd, frozenAt }
  // 线程首次需要注入时从 profile 固化；本线程后续轮次只用快照

loadOperatorMemoryPromptSection(userId, threadId): Promise<string | null>
  // 非操作员 → null
  // 若线程无快照：从该 user 的 profile 拷贝写入 snapshot，再格式化为 prompt 段
  // 若已有快照：只用快照

mutateOperatorProfile(userId, patch): Promise<{ ok: true } | { ok: false, errorCode }>
  // 只改 profile 表；不改当前线程 snapshot
  // errorCode: assistant_operator_only | memory_limit_exceeded | invalid_patch
```

**Prompt 注入位置**：与 `buildAssistantSystemPrompt` / `buildInstructionsWithContextExtras` 组装链衔接；稳定前缀段标题固定为「操作员常驻记忆（本线程冻结快照）」。

**工具**（仅操作员装载）：

```
memory_manage
  action: "add" | "replace" | "remove"
  target: "user_profile" | "agent_notes"
  text?: string          // add
  old_text?: string      // replace/remove 子串匹配
  new_text?: string      // replace
→ { ok, userProfileChars, agentNotesChars, applied: "profile_only" }
// applied 恒为 profile_only：本线程快照不变，下个新线程生效
```

### 4.2 情景检索

**方向**：Episodic → Agent（工具结果）  
**形式**：工具 + 检索函数

```
search_operator_history
  query: string
  mode: "keyword" | "semantic" | "both"   // 默认 both
  limit?: number                          // 默认 8，上限 20
→ {
    ok: true,
    hits: Array<{
      threadId: string
      messageId: string
      excerpt: string      // 已 sanitize，≤500 字
      score: number
      source: "keyword" | "semantic"
    }>
  }

函数：
searchOperatorHistoryFts(userId, query, limit): Hit[]
searchOperatorHistorySemantic(userId, query, limit): Hit[]
// 仅该操作员自己的线程消息
// excludeCurrentThread?: boolean 默认 true（工具参数）
```

**约束**：

- 非操作员不注册该工具
- excerpt 必须走与 `sanitizeRecallExcerpt` 同级消毒
- 禁止把整段历史直接拼进 system prompt；由模型按需调用
- keyword：Postgres FTS（或等价）；semantic：跨线程消息 embedding（可复用/扩展现有 message embedding 存储）
- sqlite 本地：语义可空实现返回 []；关键词尽力而为或返回明确 degraded

### 4.3 可写 Skills

**方向**：Writable Skills ↔ Runtime / Shell  
**形式**：表 + 工具 + HTTP 审批

```
表 petrichor_assistant_operator_skill
  id              bigint PK
  user_id         bigint not null        // 归属操作员
  name            text not null          // 与内置名冲突时：操作员版覆盖目录展示，load 优先操作员 active
  description     text not null
  body_md         text not null
  version         int not null default 1
  status          text not null          // active | archived
  updated_at      timestamptz
  unique (user_id, name)

表 petrichor_assistant_operator_skill_pending
  id              bigint PK
  user_id         bigint not null
  skill_name      text not null
  action          text not null          // create | edit | delete
  before_md       text null
  after_md        text null
  description     text null
  gist            text not null          // 一句话摘要供壳展示
  status          text not null          // pending | approved | rejected
  created_at      timestamptz
  resolved_at     timestamptz null

listOperatorSkillCatalog(user, domains): Array<{ name, description, source: "builtin" | "operator" }>
  // 操作员：builtin ∪ 该用户 active operator（同名 operator 覆盖 description）
  // 非操作员：仅 builtin（现状）

getSkillBody(name, user): body | null
  // 操作员优先本人 active operator skill，否则 builtin

工具 skill_manage（仅操作员）：
  action: "create" | "patch" | "edit" | "delete"
  name: string
  content?: string           // create/edit 全文
  old_string?: string        // patch
  new_string?: string        // patch
  → create|edit|delete：写入 pending，返回 { ok, pendingId, requiresApproval: true }
  → patch：直接改 active body，返回 { ok, requiresApproval: false, version }
  // patch 找不到 old_string → ok:false errorCode=skill_patch_miss

HTTP（requireCurrentUser + assertAssistantOperator）：
  POST /api/assistant/operator-skills/pending/list
    → { items: Pending[] }
  POST /api/assistant/operator-skills/pending/resolve
    { pendingId: string, decision: "approve" | "reject" }
    → approve：应用 create/edit/delete 到 skill 表；reject：只改 status
    错误：403 assistant_operator_only | 404 pending_not_found | 409 pending_not_open
```

**约束**：

- 内置 4 个 playbook 仍保留在代码；操作员 skill 是叠加层
- `load_skill` 对操作员走 `getSkillBody`
- 壳需能展示 pending 并 resolve（不新开独立记忆页；挂助手设置抽屉或任务侧栏旁路）

### 4.4 手动进化提案

**方向**：Evolution → Skills（合入） / 可选 Memory（合入走 mutateOperatorProfile）  
**形式**：表 + HTTP（一期不以 agent 工具触发进化，避免循环自改；壳或设置里按钮）

```
表 petrichor_assistant_operator_evolution_proposal
  id              bigint PK
  user_id         bigint not null
  target_type     text not null    // skill | user_profile | agent_notes
  target_name     text null        // skill name；记忆类可空
  before_md       text not null
  after_md        text not null
  rationale_md    text not null
  status          text not null    // pending | accepted | rejected
  created_at      timestamptz
  resolved_at     timestamptz null

POST /api/assistant/operator-evolution/run
  { targetType, targetName?, hint?: string }
  → { proposalId }
  // 同步或短时任务：读目标正文 + 近期相关 run/step 轨迹摘要 → 生成 after_md
  // 错误：403 | 400 invalid_target | 409 evolution_busy

POST /api/assistant/operator-evolution/list
  { status?: "pending" | "accepted" | "rejected" }
  → { items }

POST /api/assistant/operator-evolution/resolve
  { proposalId, decision: "accept" | "reject" }
  → accept + skill：直接写入 active skill（或 create），version++；不经 skill_pending 二次审批（提案本身即审批）
  → accept + memory：mutateOperatorProfile
  → 错误：403 | 404 | 409 proposal_not_open
```

**约束**：

- 禁止后台 cron 自动 run / 自动 accept
- 一期进化引擎可先 LLM 单次提案（不强制引入完整 GEPA 库）；接口形状不变，实现可替换
- 轨迹输入只读既有 assistant run/step，不新开权重训练管线

### 4.5 共享错误码

```
assistant_operator_only
memory_limit_exceeded
invalid_patch
skill_patch_miss
pending_not_found
pending_not_open
proposal_not_open
invalid_target
evolution_busy
```

## 5. 子 feature 清单

1. **operator-persistent-memory** — 门闩抽取 + profile 表 + 线程冻结快照注入 + `memory_manage`
   - 所属模块：Gate + Persistent Memory
   - 依赖：无
   - 状态：done
   - 对应 feature：2026-07-17-operator-persistent-memory
   - 备注：**最小闭环**

2. **operator-episodic-recall** — 跨线程 FTS + embedding 检索工具 `search_operator_history`
   - 所属模块：Episodic Recall
   - 依赖：operator-persistent-memory
   - 状态：done
   - 对应 feature：2026-07-17-operator-episodic-recall

3. **operator-writable-skills** — 操作员 skill 表、catalog/load 覆盖、`skill_manage`、pending 审批 API/UI
   - 所属模块：Writable Skills
   - 依赖：operator-persistent-memory
   - 状态：done
   - 对应 feature：2026-07-17-operator-writable-skills

4. **operator-evolution-manual** — 手动 run/list/resolve 进化提案并合入 skill/记忆
   - 所属模块：Manual Evolution
   - 依赖：operator-writable-skills
   - 状态：done
   - 对应 feature：2026-07-17-operator-evolution-manual

**最小闭环**：第 1 条做完后，操作员新开线程能在 system 侧看到冻结常驻记忆；对话中 `memory_manage` 写入后**本线程不变、下一新线程可见**；非操作员无注入无工具。

## 6. 排期思路

按 Hermes 依赖：先有常驻层与门闩，再检索与可写流程，最后进化（进化要写 skill）。技术依赖外的产品优先级由你拍板；默认按 1→2→3→4。2 与 3 在 1 完成后可并行（若要加速）。

卡点：线程冻结快照与现有 prompt 组装点要对齐；FTS 与跨线程 embedding 的存储/回填策略在 feature-design 内定，但对外工具契约以本第 4.2 节为准。

## 7. 观察项

- `roadmap/assistant-runtime-depth` 写明「不恢复跨会话记忆」——已被本 req + roadmap 取代；建议日后 arch/roadmap 归档时改表述，本轮不改那份 completed 文档。
- `chat-first-universal-agent` req「怎么解决」已提跨会话记忆，与本 req 互补；可选后续 `cs-req update` 加互引。
- 旧表 `petrichor_agent_memory*`：保留不 DROP；本栈不读不写。若要迁移历史蒸馏内容进短文，另开任务。
- Skills 小 patch 免审：已按 brainstorm「创建/大改需审」落契约；若要 patch 也进 pending，回 roadmap update。
- 进化是否引入真正 GEPA/DSPy：一期允许单次 LLM 提案；若要上完整进化库，在 `operator-evolution-manual` design 内选，不改 HTTP 契约。
- req 边界原文写「超级管理员」；门闩实现经 `isAssistantOperator` → `isSuperAdmin`，与站内其它管理能力一致。
