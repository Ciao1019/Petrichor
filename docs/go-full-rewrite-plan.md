# Petrichor 后端 Go 一次重构总计划

> 历史迁移记录：文中的旧 Node/Better Auth 名称仅用于说明迁移来源，不代表当前实现。
> 目标：用 `apps/api`（Gin + zap + ent + Eino）**一次性替换** `apps/web/src/server/**` 全部业务后端。
> 不做「先试点再慢慢迁」；按依赖分层在同一工程内全部实现，**联调通过后一次切流量**。
> 已定技术栈：HTTP=Gin，日志=zap，ORM=ent，Agent=Eino；**废弃 2FA/TOTP**。

---

## 1. 范围与原则

### 1.1 范围内（必须一次做完）

| 类别 | 内容 |
|------|------|
| HTTP API | 现有约 **163** 个 `/api/**` 路由（路径与请求/响应契约对齐前端） |
| Feed | `/rss.xml`、`/atom.xml` |
| 业务域 | Auth、Admin、About/Appearance/Projects、KB（树/文章/分享/烧链/Wiki/导入）、Public、Site Graph、Agent REST、MCP、AI、Assistant、Doc Library、Notification、Dashboard、Upload |
| 横切 | pagination、错误 envelope、Spring AES 密钥兼容、S3、Redis 缓存、pgvector |
| 前端配套 | 去掉 Better Auth / 2FA；会话统一 `petrichor_session`；必要时 Next 反向代理到 Go |

### 1.2 范围外 / 废弃

| 项 | 处置 |
|----|------|
| Better Auth 运行时 + `/api/auth/[...all]` | 删除；密码落到 `petrichor_user.password_hash` |
| 2FA（TOTP / backup codes / `twoFactorApi` / 登录二次校验） | **不做**；相关字段、端点与 UI 已删除 |
| `petrichor_doc_qa_*` 遗留表 | 不迁业务；ent 可不建模 |
| Next 内业务 handler | 切流后删除；Next 仅保留 SPA/SEO 薄层 |

### 1.3 硬约束（切流前必须满足）

1. 前端 `apps/web/src/lib/api.ts` 路径与字段形状不变（除 2FA 相关删除）。
2. 对外契约冻结：`Bearer ptc_live_*`、`/api/mcp`、公开分享/烧链、公开 QA 流式、RSS/Atom。
3. Assistant `/api/assistant/chat` **兼容现有 UIMessageStream**（前端不强改协议）。
4. bigint ID → JSON 字符串；错误体 `{ code, msg, path, timestamp }`；列表 `{ total, rows, code, msg }`。
5. 密码 bcrypt cost=10；AI Key 继续用 `PETRICHOR_ENCRYPT_*` Spring AES 兼容解密。

---

## 2. 交付物定义（何为「全部完成」）

- [x] `apps/api` 实现全部活跃 API + Feed，本地通过契约测试。
- [x] ent schema 覆盖全部活跃表；向量读写有 `internal/vector` 封装。
- [x] Eino 跑通完整 Assistant（工具域、确认协议、子代理、流式）。
- [x] Agent REST + MCP 与现网 scope/工具名一致。
- [x] 前端移除 2FA / Better Auth 依赖；同域 Cookie 登录可用。
- [x] Next 不再承载业务逻辑，仅保留反向代理与 SEO 薄层。
- [x] 文档：启动、环境变量、切流 checklist、回滚方案。

---

## 3. 工程结构（一次按此搭齐，禁止缺域）

```text
apps/api/
├── cmd/server/
├── ent/schema/          # 全部活跃表（约 50+）
├── internal/
│   ├── config|logger|db|crypto|cache|vector
│   ├── http/{middleware,response,pagination,router}
│   ├── auth/ (+ linuxdo)
│   ├── admin/
│   ├── about|appearance|projects
│   ├── sitegraph/
│   ├── kb/{node,article,share,burn,wiki,importjob,publicqa,summary,mindmap}
│   ├── agent/{apikey,mcp,skill}
│   ├── ai/{config,generation,write,review}
│   ├── assistant/{runtime,intent,tools,confirmation,operator,plan,memory,skills}
│   ├── doclibrary|notification|dashboard|upload|publicsite
│   └── testkit/         # 契约测试夹具
└── Makefile
```

路由挂载与现网一致：`/api/auth|admin|public|kb|agent|mcp|ai|assistant|doc-library|notification|dashboard|upload` + `/rss.xml` `/atom.xml`。

---

## 4. 实施阶段（同一大 PR / 同一分支内连续完成，不按「小功能上线」切）

> 顺序是依赖序，不是「上线批次」。全部阶段完成后再切流量。

### 阶段 A — 横切地基（阻塞一切）

| 任务 | 细节 |
|------|------|
| ent 全量 schema | 映射全部活跃 `petrichor_*` 表；`entsql.Table`；identity 主键；**不**用 ent 破坏性 migrate 生产库 |
| response / pagination | 对齐 `ok` / `tableData` / `toErrorResponse`；`pageNum` `pageSize` `isAsc` |
| crypto | 移植 Spring Text encryptor |
| upload/S3 | presign put/get、delete、local fallback |
| cache | Upstash Redis；失败降级 |
| vector | embedding 写入/检索（1024 维）；原生 SQL + pgvector |
| AI generation 内核 | OpenAI-compat / DeepSeek 等协议；chat、embed、vision |
| 配置 | 合并 web `.env`：DB、S3、Redis、LinuxDo、Encrypt、Register、Session |

**验收：** 单元测试覆盖 crypto、pagination；S3/DB 连通冒烟。

### 阶段 B — 认证与权限闭环

| 任务 | 细节 |
|------|------|
| Auth 完整 | login/register/logout/me/profile/改密（已有则补齐边界） |
| 会话 | list/revoke/revoke-others（无 TOTP 字段） |
| LinuxDo | login/start、bind/start、callback |
| 注册策略 | 首位 SUPER_ADMIN；`PETRICHOR_REGISTER_*` |
| 密码迁移校验 | 确认历史用户 `password_hash` 可读；必要时一次性 SQL 回填 |
| Admin 用户 | list/create/delete + 超管中间件 |
| 前端去 2FA | 删 `twoFactorApi`、登录 TOTP UI、会话撤销 code 输入 |

**验收：** Cookie 登录全链路；LinuxDo 绑定；超管接口 403/200 正确。

### 阶段 C — 内容主数据（KB + 文档库 + 上传）

| 任务 | 细节 |
|------|------|
| KB CRUD | 已有，对齐字段/排序 |
| Node 树 | tree/roots/children/detail/create-folder/update-folder/delete-folder/move |
| Article | create/detail/update/delete/search；move；S3 图片引用清理钩子 |
| Summary / MindMap | 依赖 AI generation |
| Share | create/revoke/info/pin |
| Burn | create/list/revoke + public meta/consume（禁缓存） |
| Doc Library | library/folder/document 全 10 端点 + Redis |
| Upload | `/upload/*` + `/public/upload/presign-get` |
| Public articles | list/search/share/detail + 缓存失效 |

**验收：** 建库→建树→写文→分享→烧链→公开阅读全路径。

### 阶段 D — AI 配置与写作 / 复盘

| 任务 | 细节 |
|------|------|
| AI config | list/create/detail/update/delete/set-default（密钥加解密） |
| Write stream | `/api/ai/write/stream` 行为对齐编辑器客户端 |
| Review | get/regenerate/list/period-options |

**验收：** 配置密钥入库加密、读出解密；写作流可用；复盘生成。

### 阶段 E — Wiki / 导入 / 星图 / 公开 QA

| 任务 | 细节 |
|------|------|
| Wiki | dashboard、page list/detail、tree、ingest、embedding/run、patch list/apply/reject、lint |
| Import | create→OCR/page-convert→retry→finalize/cancel/delete/list/detail |
| PDF | 决策见 §6；实现选定方案 |
| Site Graph | admin 全套 15 + public 1；LLM 抽取与合并 |
| Public QA | `/api/public/qa/chat` 流式 + 限流 + 图谱/wiki 检索 |

**验收：** ingest→embedding→检索；导入一篇 PDF；星图 generate/publish；公开 QA 流式回答。

### 阶段 F — 外部 Agent + MCP（对外契约优先）

| 任务 | 细节 |
|------|------|
| API Key | list/create/revoke；`ptc_live_`；scope 校验；call-log |
| Agent REST | 全部文档/文章/wiki/share/skill/manifest/capabilities |
| MCP | `/api/mcp` Streamable HTTP；**20 tools** 委托同一 service 层 |
| Skill | markdown / zip pack |

**验收：** 用真实 MCP 客户端（Cursor）连上 20 tools；scope 拒绝用例通过。

### 阶段 G — Assistant（最重，必须完整而非脚手架）

| 任务 | 细节 |
|------|------|
| Thread | list/detail/create/delete/delete-many |
| Plan patch | `/assistant/plan/patch` |
| Chat 流式 | UIMessageStream 兼容；run/step/artifact 落库 |
| Intent | 规则 + LLM 低置信兜底 |
| Tools（Eino） | knowledge / doc_library / system / content_write / admin / load_skill / memory / research_subagent / research_fanout / write_subagent / request_user_confirmation |
| Confirmation | 危险操作确认卡 + allowlist |
| Operator | profile/skills/episodic memory（超管门闩） |
| Context | pack / recall（FTS + 向量） |

**验收：** 与现网同等：检索问答、写文章提案、确认后执行、子代理并行、流式 UI 不停顿。

### 阶段 H — 站点 CMS / 仪表盘 / Feed / 通知

| 任务 | 细节 |
|------|------|
| About / Appearance / Projects | public + admin |
| Notification | summary/list/read/read-all |
| Dashboard overview | 全量聚合 KPI |
| RSS / Atom | Content-Type + Cache-Control |

**验收：** 公开首页数据、Feed、后台概览与通知可用。

### 阶段 I — 切流与清场（全部功能绿后执行）

| 任务 | 细节 |
|------|------|
| 同域代理 | Next rewrite `/api/*`、`/rss.xml`、`/atom.xml` → Go；或边缘网关 |
| Cookie | Secure/SameSite/Domain 与部署拓扑一致 |
| 契约回归 | 跑完整 API 套件 + MCP + Assistant 手工清单 |
| 删除 | `apps/web/src/server/**` 业务、Better Auth 依赖、2FA UI |
| 文档 | README / AGENTS.md / 环境变量表更新 |

---

## 5. 端点清单（按域，实现时逐条勾选）

### Auth（15 → Go 自建，去掉 BA/2FA）
`login` `register` `logout` `me` `profile` `profile/update` `password/change` `sessions` `sessions/revoke` `sessions/revoke-others` `linuxdo/login/start` `linuxdo/bind/start` `linuxdo/callback`
❌ 不做：`[...all]`、`two-factor/*`

### Admin / CMS
- User ×3；About ×2；Appearance ×2；Projects ×2；Site Graph ×16

### KB
- knowledge-base ×5；node ×8；article ×9；share ×4；burn ×3；wiki ×10；qa meta ×2；import ×10

### Public
- about/appearance/projects/site-graph；article list/search/share；burn meta/consume；qa/chat；upload/presign-get

### Agent / MCP
- agent ×30；mcp ×1

### AI / Assistant / Doc / 其它
- ai ×11；assistant ×7（含 chat 大改）；doc-library ×10；notification ×4；dashboard ×1；upload ×3；rss/atom ×2

---

## 6. 必须拍板的技术决策（开始大干前确认）

| # | 问题 | 建议默认 |
|---|------|----------|
| 1 | Assistant 流式协议 | **兼容 UIMessageStream**，不改前端协议 |
| 2 | PDF 抽取 | **Go 调现有 pdf-inspector sidecar**（或容器内 Node 小服务）；后续可换纯 Go |
| 3 | MCP 实现 | Go 内直接实现 Streamable HTTP，路径仍 `/api/mcp` |
| 4 | 部署 | 前端 Vercel + Go（Cloud Run/Fly）**同域反代**；Cookie 不跨站 |
| 5 | 旧 `kb_agent_*` 表 | Wiki 逻辑继续读写；产品入口只保留 Assistant |
| 6 | Better Auth 表 | 已停止创建和读写；旧数据库可在确认无回滚需求后另行归档 |

请确认以上默认；有异议在开工前改。

---

## 7. 测试与验收策略（一次做完的质量闸门）

1. **契约测试**：按 `api.ts` + Agent/MCP/公开流式路径建表驱动用例（登录态 / API Key / 匿名）。
2. **域集成测试**：每个阶段末跑对应套件；阶段 I 前全绿。
3. **兼容黄金路径**（人工/脚本）：
   - 注册登录 → 建 KB → 写文章 → 分享公开 → 烧链
   - 配 AI → Wiki ingest → 公开 QA
   - 创建 Agent Key → MCP list tools → create_article
   - Assistant 流式对话 → 危险工具确认 → 落库
4. **回归**：`go test ./...`；关键路径压力/超时（导入、星图 generate）。
5. **回滚**：保留部署版本与数据库备份；业务实现不再回切到已删除的 Node 后端。

---

## 8. 工作量与并行方式（仍属「一次交付」）

| 泳道 | 内容 | 依赖 |
|------|------|------|
| 地基 | A 横切 | — |
| 身份 | B Auth/Admin/前端去 2FA | A |
| 内容 | C KB/Doc/Upload/Public articles | A,B |
| 模型 | D AI config/write/review | A,B |
| 智能内容 | E Wiki/Import/Graph/PublicQA | A,C,D |
| 对外 | F Agent/MCP | A,C,D,E(wiki) |
| 助手 | G Assistant 完整 | A–F 服务层可调用 |
| 收尾 | H CMS/Dashboard/Feed + I 切流 | 全部 |

并行规则：地基合并后，内容/模型/对外可多 Agent 并行写，但 **同一分支持续集成**，禁止分批上线半成品 API。

粗量级：Node 服务端 ~33k LOC + 流式/MCP/向量；完整 Go 重写预计 **数周量级的连续工程**，不是「几天补几个 handler」。

---

## 9. 当前状态（2026-08）

**已完成（`apps/api`，可设 `PETRICHOR_GO_API_URL` 全量代理）：**

- A–I 主路径：Auth（含 LinuxDo）、Admin/CMS、KB/Wiki/Import/OCR、公开文章/烧链/QA、Site Graph、AI config/write/review、Agent REST+MCP、Assistant UIMessageStream+工具+确认、RSS/Atom、Doc Library。
- Assistant：全量工具域（knowledge/doc_library/system/content_write/admin/research/write_subagent）+ `data-intent-route` / `data-context-compress` / `data-step-budget` + 意图规则/LLM + 嵌套研究/写入子代理 + 向量上下文召回。
- 向量：`internal/vector` + EMBEDDING 模型；`/kb/wiki/embedding/run`；Agent `document/semantic-search`。
- 星图：LLM 批抽取 generate + validate/merge/subtree/neighborhood。
- 摘要/脑图：KB + Agent 真 LLM 生成（content-hash 缓存）。
- Node `apps/web/src/server/**` 与 `apps/web/app/api/**` 已删除。

---

## 10. 切流步骤

1. 启动 Go：`pnpm dev:api`（或 `make run`）
2. Web：配置 `PETRICHOR_GO_API_URL=http://127.0.0.1:8080` 后 `pnpm --filter @petrichor/web dev`
3. 跑 §7 黄金路径回归

**已完成：** Node `apps/web/src/server/**` 与 `apps/web/app/api/**` 已删除；业务 API 仅由 Go 提供。

---

*本计划对应仓库：`apps/web` 前端 → `apps/api` Go 后端。*
