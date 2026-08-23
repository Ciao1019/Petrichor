# Petrichor 后端 Go 重构迁移方案

> 状态：草案（待确认后实施）
> 前提：**前端零改动**（`apps/web/src/**` 不动，Next.js 继续承担页面渲染、RSS/sitemap/SEO metadata）
> 目标：将 `/api/*` 后端迁移到独立 Go 服务，落在仓库已预留的 `apps/api/` 目录

---

## 1. 现状盘点

### 1.1 规模

| 维度 | 数量 |
|---|---|
| route.ts 文件 | 182 个（12 个顶层目录） |
| 方法级端点 | 197 个 |
| 需登录端点 | 116 |
| Agent API Key 鉴权端点 | 26（agent 组 24 + mcp 2） |
| 超管端点 | 24（全部在 admin 组） |
| 完全公开端点 | 31 |
| 流式响应端点 | 3（ai/write/stream、assistant/chat、public/qa/chat） |
| 服务端 TS 模块 | ~200 个文件 / 3.1MB |

### 1.2 认证体系（双会话通道）

`requireCurrentUser`（`apps/web/src/server/auth/current-user.ts`）按顺序尝试两条通道：

1. **Better Auth 会话**：`auth.api.getSession(headers)` 校验 `__Secure-petrichor.session_token` cookie（生产前缀），命中后滚动续期，并经 bridge 保证 `petrichor_user` 行存在。
2. **自建 token 会话**：取 `petrichor_session` cookie 或 `Authorization: Bearer <token>`，对 token 做 **sha256 hex** 哈希后查 `petrichor_auth_sessions` 表（`token_hash` 匹配 + 未撤销 + 未过期），命中后更新过期时间与 `last_seen_at`。

Go 兼容策略：通道 2 是纯查表逻辑，可 1:1 移植；通道 1 的 Better Auth cookie 是签名 token，逆向成本高——详见 §3 阶段 2 的路线决策。LinuxDo OAuth、2FA、bcrypt 密码双写均需评估归属。

### 1.3 必须逐字节复刻的响应契约

- 错误体 `{ code, msg, path, timestamp }` 且 HTTP status 同步；401 触发前端跳转 `/login?redirect=...`，409 在助手页触发"去配置模型"提示。
- 列表体 `{ total, rows, code: 200, msg }`（RuoYi 风格）；分页参数 `pageNum/pageSize/isAsc/orderByColumn`。
- bigint ID 一律序列化为字符串返回。
- 流式接口：assistant/chat 为 UIMessage 流协议并带自定义响应头 `CHAT_THREAD_HEADER`；ai/write/stream 为纯文本流；前端错误解析只认 body 的 `msg` 字段。
- 双方法兼容惯例：public/admin 组 detail 类端点同时导出 GET+POST。

### 1.4 关键依赖与 Go 对照

| 依赖 | 现状 | Go 方案 |
|---|---|---|
| PostgreSQL | postgres.js（prepare:false，Supabase pooler） | pgx/v5 ✅ |
| 查询构建 | Drizzle + 大量 raw SQL | sqlc / pgx 原生 SQL 平移 ✅ |
| pgvector | 动态维度 vector 列 + 按维度部分 HNSW 索引（`retrieval/vector-space.ts`） | DDL 管理逻辑需 1:1 移植 ⚠️ |
| bcrypt | bcryptjs | x/crypto/bcrypt ✅ |
| S3 | 自研 SigV4 预签名（~100 行 HMAC，未用 AWS SDK） | aws-sdk-go-v2 presign 或照抄实现 ✅ |
| 缓存 | Upstash Redis REST + 两处进程内缓存（embedding 查询缓存、公开内容缓存） | Upstash REST 即 HTTPS+JSON，数十行封装 ✅ |
| AI Provider | ~24 家 provider + quirks 中间件 + Mastra 最小 agent loop | 主流有官方 Go SDK，长尾手写 OpenAI 兼容客户端 ⚠️⚠️ 最大工作量区 |
| PDF 解析 | @firecrawl/pdf-inspector（导入链路核心） | **Go 无等价物**，见风险 R1 |
| MCP | mcp-handler（Streamable HTTP，Bearer Key） | modelcontextprotocol/go-sdk ✅ 首批迁移候选 |
| 异步任务 | Next `after()`（导入后台处理、S3 清扫），无 cron/webhook | goroutine + 任务表轮询 ✅ 更简单 |

### 1.5 部署形态

- Vercel Docker 模式（`Dockerfile.vercel`）：Next standalone 承载全部流量，部署前自动执行 `docs/migrations/manifest.json` 登记的增量 SQL。
- 无 CI、无 middleware.ts、服务端零 CORS 头（前后端永远同源）。

---

## 2. 核心架构决策

### 2.1 【关键】同源反代分流，而非跨域直连

事实依据：

- axios baseURL 硬编码 `/api`（`src/lib/api.ts`），无可配置项；
- 另有 2 处独立硬编码 fetch（`stream-client.ts`、`AssistantChatPage.tsx`）；
- 三类认证 cookie 全部 `SameSite=Lax`，跨站请求不携带；
- 服务端零 CORS 支持。

若 Go 跨域直连，必须同时改前端两处 fetch、cookie 改 SameSite=None、Go 实现 CORS、Better Auth trustedOrigins 加白——违背"前端不动"，且受 Safari ITP / 第三方 cookie 淘汰长期威胁。

**结论：入口层按路径反代到 Go 服务**

```
浏览器 ──▶ 入口（Nginx/Caddy 或 Next rewrites）
             ├── 已迁移路径   ──▶ Go 服务（apps/api）
             └── 未迁移路径   ──▶ Node（现状不变）
```

浏览器视角完全同源：cookie、CSRF、流式语义全部不变。注意反代的 SSE/长连接超时与 `Set-Cookie` 透传配置。

### 2.2 Go 服务形态

- 位置：`apps/api/`；框架用标准库 net/http + chi 路由，不引入重框架。
- 数据访问：pgx/v5 + sqlc（raw SQL 近乎原样平移），沿用 transaction pooler 约束。
- 布局建议：

```
apps/api/
├── cmd/server/main.go
├── internal/
│   ├── httpx/        # errorJson/ok/tableData、分页、鉴权中间件
│   ├── auth/         # 会话校验、API Key、OAuth
│   ├── kb/ doclib/ admin/ ...   # 按域拆分
│   ├── ai/           # provider 客户端、embedding、流协议
│   ├── storage/      # S3 presign
│   └── db/
├── sqlc.yaml
└── go.mod
```

### 2.3 数据库：共享 schema，不引入第二套迁移工具

Go 连同一个 Supabase 库；schema 权威源仍是现有 Drizzle 迁移机制（`db:migrate:vercel` 保留在部署流水线）。vector 动态维度索引的 DDL 管理函数从 `retrieval/vector-space.ts` 移植为 Go 内部实现。

---

## 3. 分阶段迁移路线（绞杀者模式）

每阶段验收标准：**契约对比测试全绿 + 灰度观察数天 + 一键回滚（改回反代规则即可）**。

### 阶段 0：基建（约 1~2 天）

- [ ] `apps/api/` Go 骨架、Dockerfile、根 pnpm scripts 包装（`go build/test/lint`）
- [ ] HTTP 契约层：errorJson/ok/tableData、分页解析、ID 规范化（字符串或数字→正整数）
- [ ] 反代分流设施，默认 100% 流量仍指向 Node
- [ ] **契约测试框架（质量安全网，必须先行）**：对同一请求分别打 Node 与 Go，diff status/headers/body 结构；录制真实流量做回放
- [ ] GitHub Actions CI

### 阶段 1：公开只读接口（约 3~5 天）

范围：public 组 18 个无鉴权端点（about/appearance/projects/site-graph/article/wiki）+ notification 组 4 端点。

- notification 恰好只依赖自建 session 通道，可提前验证鉴权中间件
- 复刻公开内容缓存语义（Upstash REST + 进程内 TTL + 失效函数）
- 验收：前台博客页面切流后无感知差异

### 阶段 2：认证【最大决策点】（约 1~2 周）

| 路线 | 内容 | 评价 |
|---|---|---|
| 甲（推荐） | Go 只"验"不"发"：实现 requireCurrentUser 等价物（双通道查询+续期写库）；login/register/OAuth/改密 8 个端点暂留 Node | 不逆向 Better Auth cookie 签名与 2FA 细节，风险小；代价是 Node 暂不能下线 |
| 乙 | Go 完整接管 auth 组 | 需逆向签名算法、TOTP、session 表全字段语义并保证历史 cookie 兼容；登录挂了全站不可用，建议作为彻底去 Node 的后续独立立项 |

本阶段同时交付 Agent API Key 中间件（Bearer/x-api-key、scope 校验、调用日志），为阶段 5 铺路。

### 阶段 3：CRUD 业务主体（约 2~3 周）

按风险从低到高逐组迁移，每组完成即切流：

1. dashboard/overview（纯聚合查询）
2. kb 组 52 端点（模式统一：入参校验→DB→tableData）
3. doc-library 组 10 端点（注意鉴权写在 route 层的特殊性）
4. admin 组 24 端点（超管中间件）
5. upload 组（SigV4 presign + 本地对象读写；GET 公开语义保持不变）
6. kb/import 登记类端点（后台处理循环归阶段 5）

### 阶段 4：AI 集成层【工作量重心】（约 3~4 周）

- [ ] UIMessage 流协议兼容层（assistant/chat、public/qa/chat）：分帧格式、CHAT_THREAD_HEADER、409 语义
- [ ] ai/write/stream 纯文本流
- [ ] embedding 抽象、维度探测、查询向量进程内缓存
- [ ] provider 客户端矩阵：先覆盖实际启用的供应商（OpenAI 兼容协议一把抓），长尾逐步补齐；quirks body 改写逻辑逐条移植
- [ ] assistant V1/V2 tool-calling 循环：Mastra 仅承担最小 loop，Petrichor 自研的 State/Plan/Evidence/StopPolicy/Trace 本就在外层，Go 重写时顺势收编

### 阶段 5：Agent/MCP 与后台任务（约 1~2 周）

- [ ] agent 组 24 端点（API Key 鉴权已在阶段 2 就绪）
- [ ] MCP Server 迁移（go-sdk），验证 Streamable HTTP 行为一致
- [ ] 导入任务后台循环：`after()` 语义改为 goroutine + 任务表轮询（带并发上限）；S3 未引用对象清扫同理
- [ ] public/qa/chat（公开流式 + visitor/IP 双限流）

### 阶段 6：收尾下线（约 1 周）

- [ ] 决策 auth 归属（若接受长期保留 Node auth 边车则到此为止；否则启动路线乙）
- [ ] PDF 解析方案落地（见风险 R1）
- [ ] Node /api 全量切 Go，Next 仅保留页面/RSS/sitemap/SEO
- [ ] 更新 AGENTS.md、README、部署文档

---

## 4. 工作量评估汇总

| 阶段 | 内容 | 预估 |
|---|---|---|
| 0 | 基建+契约测试框架 | 1~2 天 |
| 1 | 公开接口+notification | 3~5 天 |
| 2 | 会话校验+API Key 中间件 | 1~2 周 |
| 3 | CRUD 主体 ~100 端点 | 2~3 周 |
| 4 | AI 流式+provider 矩阵 | 3~4 周 |
| 5 | agent/MCP/后台任务 | 1~2 周 |
| 6 | 收尾 | ~1 周 |
| **合计** | | **约 2.5~3.5 个月全职当量** |

注：按"熟悉两边技术栈的 1 人全职"估算；契约测试框架能显著压缩阶段 3/4 的联调时间。

---

## 5. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **PDF 解析无 Go 等价物**（firecrawl pdf-inspector 是导入链路核心） | 三选一：保留 Node 微服务边车仅做 PDF 抽取 / go-pdfium 绑定（CGO，部署复杂）/ 商业库。建议先边车，后续再评估 |
| R2 | UIMessage 流协议是私有分帧格式，前端 transport 对其有隐式假设 | 契约测试录制真实会话回放比对字节级差异 |
| R3 | Better Auth 逆向成本高 | 采用路线甲隔离风险；auth 留 Node 不阻塞整体迁移 |
| R4 | quirks 中间件遗漏导致某家 provider 静默出错 | 按"实际启用优先"排序迁移；每家 provider 上线前用 probe/test 接口回归 |
| R5 | 双服务并行期 schema 演进不同步 | schema 权威源唯一（Drizzle 迁移机制），Go 只读跟随；禁止 Go 侧直接改表 |
| R6 | serverless after() 语义差异（实例回收丢任务） | Go 常驻进程反而更稳：goroutine + 任务表状态机，天然支持重试 |
| R7 | Supabase pooler 下 pgx 连接行为差异 | 沿用 prepare:false 等效配置（pgx default_query_exec_mode=exec），压测验证 |

---

## 6. 待确认决策点

1. **反代实现**：入口 Nginx/Caddy（推荐，对流式最友好）还是 Next rewrites（改动最小）？当前 Vercel Docker 部署两者皆可。
2. **auth 路线**：接受甲路线（auth 长期留 Node 边车）还是最终必须彻底去 Node（需立项路线乙）？
3. **PDF 链路**：接受 Node 边车过渡，还是希望本次一并解决？
4. **AI provider 范围**：先只迁实际启用的供应商，长尾保留在 Node 直至全部就绪——是否接受这种双轨期？
5. **Go 服务托管位置**：与 Next 同一 Docker Compose 内网互通，还是独立部署（Fly.io/Railway 等）？

---

## 附：调研依据

- 路由盘点：apps/web/app/api/**（182 route.ts / 197 端点，含鉴权方式与 handler 映射）
- 认证：apps/web/src/server/auth/{session,current-user,better-auth,linuxdo-handlers}.ts
- 响应契约：apps/web/src/server/http/response.ts、src/lib/api.ts（拦截器消费逻辑）
- 数据层：apps/web/src/server/db/schema.ts、retrieval/vector-space.ts、docs/migrations/
- 基础设施：apps/web/src/server/upload/、cache/、ai/、kb/pdf-extract.ts、vercel.json、Dockerfile.vercel

