# Petrichor Go API（apps/api）

> 分支：`feature/go-backend-rewrite`。前端与 Next.js 页面渲染不变，Go 服务接管 `/api/*`。

## 本地运行

```bash
# 终端 1：Go API（需 DATABASE_URL / SESSION_SECRET，与 apps/web 相同）
cd apps/api
DATABASE_URL="postgres://..." SESSION_SECRET="..." PETRICHOR_API_PORT=8080 go run ./cmd/server

# 终端 2：Next.js 前端 + 反代分流
cd apps/web
PETRICHOR_GO_API_URL=http://127.0.0.1:8080 pnpm dev
# 只分流部分路径（灰度）：
# PETRICHOR_GO_API_PREFIXES="api/public,api/notification" PETRICHOR_GO_API_URL=... pnpm dev
```

`PETRICHOR_GO_API_URL` 未设置时 Next.js 行为与原版完全一致（零风险回滚：去掉环境变量重启即可）。

## 验证

```bash
cd apps/api
go build ./...
go vet ./...
go test ./internal/...
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 必填，与 web 相同（Supabase transaction pooler 兼容，内部禁用预编译语句） |
| `SESSION_SECRET` | 必填 ≥32 字符；用于 Better Auth 会话 cookie 的 HMAC 验签 |
| `PETRICHOR_SESSION_EXPIRE_SECONDS` | 会话时长，默认 172800 |
| `PETRICHOR_API_PORT` | 监听端口，默认 8080 |
| `S3_*` / `PETRICHOR_STORAGE_DIR` | 对象存储双模式，同 web |
| `PETRICHOR_ENCRYPT_KEY` / `PETRICHOR_ENCRYPT_SALT` | AI 凭证加密，同 web（有内置默认回退，生产必须显式配置且不得更换历史值） |
| `NEXT_PUBLIC_REGISTER_ENABLED` / `PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE` | 注册开关与默认角色 |
| `UPSTASH_REDIS_REST_URL/_TOKEN` | 可选共享缓存；未配置回退进程内缓存 |

## 已知偏差（相对 Node 版）

完整决策清单见各 PR 描述，重点：

1. **2FA 移除**（产品决策）：登录密码通过即发会话，不再进入两步验证；`profile.twoFactorEnabled` 恒 false。
2. **AI provider 协议**：OpenAI 兼容（含 chat）、Anthropic Messages、Google Gemini 已实现；`azure / amazon-bedrock / google-vertex` 与 OpenAI Responses 协议返回明确错误（需要云厂商凭证的场景建议继续留在 Node 边车或后续补充）。
3. **PDF 导入**：视觉 OCR 走 VISION 模型逐页转写已实现；本地 PDF 文本抽取（firecrawl pdf-inspector）无 Go 等价物，导入链路建议依赖 OCR 模式。
4. **assistant/chat 运行时**：对外 UIMessage 流协议、落库结构与 409 语义一致。已移植 V2 Runtime 核心（复杂度判定/计划/上下文组装预算/工具执行器/证据与观察/停止策略/循环检测/质量门/强制收敛/knowledge+wiki 检索工具/load_skill 元工具），aicore 新增 OpenAI 兼容协议 tool-calling（流式 tool_calls 聚合）。剩余偏差：
   - Anthropic / Google 协议暂不支持工具调用（走无工具补全）；
   - research / writer / memory / graph / document / admin 域工具未移植（技能目录可见，加载后仅有说明）；
   - 子代理委派服务面已有门控但未接线并行执行器；危险操作确认票据流、LLM 注入分类器未移植；
   - chat-handler 侧规则意图路由（router-hint）与持久摘要召回（context-pack/recall）未接线。
5. **MCP**：JSON-RPC over HTTP 最小实现（initialize/tools/list/tools-call），13 个核心工具，无 SSE 传输（与 TS 版行为一致）。
6. **SQLite 方言**：Go 仅支持 PostgreSQL（生产路径）；本地开发请连 Postgres。
