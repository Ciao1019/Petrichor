# Petrichor Go API

基于 **Gin + zap + ent + Eino** 的业务后端，已经替换原 Next.js TypeScript 后端。迁移记录见 `docs/go-full-rewrite-plan.md`。

## 技术选型

| 层 | 选择 |
|---|---|
| HTTP | Gin |
| 日志 | zap |
| ORM | ent |
| Agent | Eino ReAct + 业务工具 |
| PDF | pdf-inspector sidecar（`PETRICHOR_PDF_INSPECTOR_URL`） |

## 能力覆盖（可切流）

- Auth：登录/注册/会话 + **LinuxDo OAuth**（无 2FA）
- Admin / CMS：用户、About、Appearance、Projects
- KB：知识库/树/文章/分享/烧链/Wiki/Import（含 Vision OCR）
- 文档解析流水线：上传即返回，后台跑「文档解析 → 分块 → 向量化 → 多模态识别 → 后处理 → Wiki（可选异步）」六阶段，
  全程写 span（`/kb/document/spans` 供前端画时间线）；每次上传可覆盖解析引擎、分块、图像处理、
  AI 问题生成与文档标签
- 公开面：文章列表/搜索/分享/烧链、Site Graph、Public QA 流式
- AI：config CRUD、write stream、review
- Agent：对外 REST + MCP JSON-RPC + Skill/SkillPack
- Assistant：UIMessageStream（含 `data-*` parts）+ 全量 Eino 工具域 + 确认/allowlist + 研究/写入子代理 + 向量上下文召回
- 向量语义检索：Wiki embedding/run + Agent semantic-search
- 星图：LLM 抽取 generate + merge/validate
- 摘要/脑图：KB/Agent 真 LLM 生成
- Feed：`/rss.xml`、`/atom.xml`
- Doc Library / Upload / Notification

## 本地启动

```bash
cd apps/api
cp .env.example .env.local
make tidy && make generate && make run
```

在 `.env.local` 设置服务端配置后，Web 通过 `PETRICHOR_GO_API_URL` 把 `/api`、Feed、healthz 全部代理到 Go：

```bash
PETRICHOR_GO_API_URL=http://127.0.0.1:8080
```

## 验证

```bash
go build ./...
go test ./internal/...
curl -s http://127.0.0.1:8080/healthz
```

## 说明

- 前端通过 Next rewrite 访问本服务。
- EMBEDDING / CHAT 模型需在后台 AI 配置中启用（密钥走 `PETRICHOR_ENCRYPT_*` 解密）。
