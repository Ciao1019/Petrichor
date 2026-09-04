# 桌面端（本地版）开发计划

> 实施状态：方案设计阶段，尚未开工。本文记录桌面化的总体架构、关键决策、分阶段计划与风险。
> 行为和代码位置以当前仓库为事实来源；开工后请同步更新本文的"实施状态"。

## 1. 目标

把 Petrichor 交付为一版桌面应用，核心诉求：

1. **数据全部本地**：数据库、上传文件、任务状态、缓存只存在于用户机器，不依赖任何云端托管服务。
2. **UI 不变**：现有 `apps/web` 的 React SPA 界面、交互、路由原样保留。
3. **免登录**：单机单用户，不再有注册、邮箱密码与 LinuxDo OAuth 流程。
4. **AI 零配置**：不要求用户在应用内配置模型供应商；自动检测本机已安装的 agent CLI
   （pi、Codex、Claude Code），直接以它们作为 AI 能力来源——这些 CLI 自带各自的登录态。

## 2. 非目标

本轮不做以下事项：

- 不重写前端设计系统、不做 Electron 原生菜单定制，WebView 内就是现有 SPA。
- 不把 PostgreSQL 迁移为 SQLite / DuckDB 等嵌入式数据库（理由见 5.2）。
- 不维护云端同步、多设备、多用户与团队权限。
- 不在本轮处理代码签名、自动更新之外的分发合规（如 Windows SmartScreen 申诉）。
- 不要求桌面端实现云端版全部模型供应商；见 5.6 的能力取舍。

## 3. 现状调研结论

改造难度高度集中在一个点上——PostgreSQL 的本地交付；其余模块均有现成的降级或替代路径。

| 模块 | 现状 | 桌面化难度 | 结论 |
| --- | --- | --- | --- |
| 前端 SPA | axios `baseURL: "/api"` + `withCredentials`（`apps/web/src/lib/api-client.ts`），全库无硬编码 API host；流式走 `fetch` 手工解析 SSE；`/demo` 模式已证明前端数据层可替换 | 低 | WebView 直接加载同源地址即可 |
| Go API | Gin + pgx/v5 原生 SQL（`apps/api/internal/db/db.go`），internal 下约 532 处原生 SQL；Goose 迁移内嵌（`apps/api/migrations/embed.go`） | — | 主体原样复用 |
| 数据库 | PostgreSQL 16+，依赖 `pgvector`（`<=>`、`vector` 列）、`pg_trgm`（`similarity()`）、`tsvector` 生成列 + GIN，是检索层基础设施 | **高** | 内嵌真 PG，见 5.2 |
| S3 存储 | 已有本地目录双模式：`[storage].local_directory`（`apps/api/internal/storage/local.go`），URL 为同源 `/api/upload/local/<objectKey>` | 零 | 直接启用本地模式 |
| Redis 缓存 | `apps/api/internal/cache/cache.go` 已有进程内降级（sync.Map + singleflight），仅 15 处 `ReadThrough` | 零 | 桌面模式强制进程内 |
| 队列 | Asynq 双队列（`knowledge_build`、`document_import`），`apps/api/internal/taskqueue/taskqueue.go` 注明"不允许进程内降级"；处理函数本身是普通 Go 函数，任务/页进度/死信已落 PG（`kb/document_import_store.go`、`kb/job_retry.go`） | 中 | 写进程内 runner，见 5.4 |
| 鉴权 | Sa-Token-Go 会话存 PG（非 Redis）；9 组 `RequireUser` 中间件 + 约 76 处 `auth.CurrentUser(c)`；已有 `[auth.local_development]` 免密单用户模式（`internal/auth`，仅限 development） | 低 | 复用免密逻辑，见 5.5 |
| AI / Agent | 自研统一模型层 `apps/api/internal/aicore/`（手写 OpenAI 协议 + SSE），纯出站 HTTPS；模型绑定存 DB（`aicore/resolve.go` 按 `user_id + purpose` 查 `petrichor_ai_binding`）；主 agent 循环为 Go 进程内实现（`assistantsvc/runtime/`）；已有 MCP Server（`agentapi/mcp.go`，HTTP JSON-RPC） | 低→中 | CLI 化改造，见 5.6 |
| 桌面化基础 | 仓库无任何 tauri/wails/electron 配置 | — | 从零搭壳 |

## 4. 总体架构

```mermaid
flowchart TB
  subgraph tauri["Tauri 2 壳（Rust）"]
    webview["WebView<br/>现有 React SPA，UI 零改动"]
    tray["单实例锁 · 托盘 · 自动更新"]
  end

  webview -- "http://127.0.0.1:动态端口" --> sidecar

  subgraph sidecar["Go sidecar（现有二进制 + desktop 模式）"]
    static["go:embed 静态资源<br/>（替代 Caddy，保持同源）"]
    queue["进程内任务 runner<br/>（替代 Redis + Asynq）"]
    mcp["`petrichor mcp` 子命令<br/>stdio MCP Server"]
    agentcli["agentcli 模块<br/>检测 pi / codex / claude"]
  end

  sidecar --> pg["内嵌 PostgreSQL 16<br/>appData/pgdata（pgvector + pg_trgm）"]
  sidecar --> files["本地文件存储<br/>appData/files"]
  agentcli -- "spawn 子进程" --> cli["pi / codex / claude CLI"]
  cli -- "stdio MCP 工具调用" --> mcp
```

核心决策：

1. **Tauri 2 + Go sidecar**：Go API 作为独立进程被 Tauri 拉起，零代码重构；WebView 加载
   `127.0.0.1:<端口>`。备选 Wails 3（Go 同进程、少一个 sidecar）仍在 beta，不选。
2. **静态资源 `go:embed` 进 Go 二进制**：由 Go 自己伺服 `dist/`，Tauri 只需指向一个端口，
   彻底保持同源，前端协议零改动。
3. **单一 Go 二进制 + 运行模式开关**：以环境变量 `PETRICHOR_DESKTOP=1`（由 Tauri sidecar
   配置注入）区分桌面模式，不维护平行分支与双二进制；MCP stdio 以 `petrichor mcp` 子命令进入。

## 5. 关键设计

### 5.1 桌面壳与进程生命周期

- Tauri 2 通过 sidecar 机制拉起 Go 二进制，绑定 `127.0.0.1:<动态空闲端口>`，轮询 `/healthz`
  就绪后再加载页面。
- 退出顺序：WebView 关闭 → Go 优雅关停（复用现有关停逻辑）→ 内嵌 PG 停库 → 壳退出。
- 端口不落盘、每次启动动态分配，避免与其他本地服务冲突。
- 可选加固：Go 只监听回环地址并校验一个启动期生成的本地 token，防止同机其他进程误触 API。

### 5.2 内嵌 PostgreSQL（唯一硬点）

检索层深度依赖 `pgvector`、`pg_trgm` 与 `tsvector` 生成列，换嵌入式数据库等于重写整个检索层，
因此桌面端继续使用真 PostgreSQL：

- 采用 `github.com/ferretdb/embedded-postgres`（zonky 二进制方案的 Go 封装；其 fork 打包了
  pgvector——**开工前需先验证各平台产物确实包含 pgvector 与 pg_trgm**，这是全方案最大的
  不确定性，见第 7 节）。
- 首启执行 `initdb` 到 `appData/pgdata`，然后复用现有 Goose 自动迁移路径建库建扩展；
  迁移失败则壳提示错误，不允许进入应用（与现有一致）。
- PG 端口取动态空闲端口，Unix socket / TCP 均可，随应用退出停止。
- 数据目录（含 Unicode、空格路径）需在 macOS / Windows / Linux 三平台实测。

### 5.3 本地文件存储

- 直接启用 `[storage].local_directory = "<appData>/files"`，上传、预签名、`s4key:` 引用链路
  全部复用现有本地模式实现，前端 XHR 直传代码不变。

### 5.4 缓存与任务队列进程内化

- 缓存：桌面模式强制走 `cache/cache.go` 的进程内降级实现，无 Redis 依赖。
- 队列：新增进程内 runner 替代 Asynq + 独立 Worker 进程：
  - PG 任务表 + `FOR UPDATE SKIP LOCKED` 出队 + goroutine worker 池，复用现有处理函数
    （`kb.HandleKnowledgeBuildTask` 等）与状态/进度/死信表。
  - 保留重试与超时语义对齐 Asynq 现配置（30min/重试 2；6h/重试 4）。
  - `taskqueue.go` 中"禁止进程内降级"的约束改为按 desktop 模式放开。
  - 现有每分钟 `reconcile` 补偿逻辑改为进程内 ticker，应用重启后续跑未完成任务。
  - 已知取舍：应用退出会中断长任务（如 6h 视觉导入），依赖 PG 状态 + 重启续跑兜底。

### 5.5 免登录单用户

- 首启自动创建本地用户（直接复用 `[auth.local_development]` 的免密逻辑，把仅限 development
  的开关放开为 desktop 模式标志）。
- desktop 模式下各路由组 `RequireUser` 直接注入该本地用户；`auth.CurrentUser(c)` 返回值不变，
  76 处调用点零改动。
- LinuxDo OAuth 运行时禁用；前端 401 拦截（`api-client.ts`）与 `/login` 路由在 desktop 构建
  下 no-op。前端通过运行时注入的构建标识或 `/api` 探测接口感知桌面模式。

### 5.6 AI：本地 agent CLI 自动检测与集成

新模块 `apps/api/internal/agentcli`：

**检测**

- 扫描 `PATH` 查找 `pi`、`codex`、`claude`，执行 `--version` 采集版本，结果缓存；
  设置页展示检测状态与使用中的 CLI。
- 无需用户配置任何 Key：CLI 各自维护自己的登录态与默认模型。

**集成方式（推荐 Mode A：CLI 当 agent 大脑，应用当工具服务器）**

- Go 二进制新增 `petrichor mcp` 子命令：用官方 `modelcontextprotocol/go-sdk` 暴露 stdio
  MCP Server，把现有进程内工具（wiki 检索、知识构建、文档导入等）注册为 MCP 工具。
- 用户发消息 → spawn 对应 CLI 非交互模式并注入 MCP 配置：
  - Claude Code：`claude -p --output-format stream-json --mcp-config ...`
  - Codex：`codex exec --json ...`
  - pi：one-shot 模式 + MCP 配置（落地时以各家当前文档核对具体 flag）
- CLI 通过 stdio 调用应用工具，JSON 流映射到现有 SSE 分段协议回传聊天 UI；自研
  planner/executor 循环在桌面模式被绕开，工具语义由 CLI 原生处理。

**Mode B（兜底）：CLI 当纯 chat model**

- 关闭 CLI 的 agentic 行为，包装成与 `aicore` 同接口的模型塞进现有 runtime 循环。
- 各 CLI 行为差异大、工具调用映射不可靠，仅用于简单问答兜底，不做主力。

**Embedding 的取舍**

- pi / codex / claude 均不提供 embedding 能力。语义检索策略：
  1. 默认降级为已建好的 `tsvector` 全文 + `pg_trgm` 相似度文本检索（向量表结构与 SQL 全保留）；
  2. 检测到 Ollama / LM Studio 时自动启用本地 embedding（`aicore/catalog.go` 本就支持这两种
     openai-compatible 供应商）。
- `petrichor_ai_binding` 桌面模式自动写入 `cli:auto` 绑定，`aicore/resolve.go` 优先返回
  CLI 适配器；设置页仍可显式切换。

### 5.7 数据目录布局

```text
<appData>/                       # macOS: ~/Library/Application Support/Petrichor
  petrichor.toml                 # 桌面端自动生成的最小配置
  pgdata/                        # 内嵌 PostgreSQL 数据目录
  files/                         # 本地对象存储（[storage].local_directory）
  logs/                          # Go API 与壳的日志、崩溃报告
```

卸载即删除该目录（可选提供"打开数据目录"入口与导出功能，复用知识可移植性能力）。

## 6. 分阶段实施

| 阶段 | 内容 | 预估 | 验收 |
| --- | --- | --- | --- |
| 0 风险验证 | 验证 ferretdb/embedded-postgres 各平台产物含 pgvector / pg_trgm；验证三家 CLI 非交互协议 | 2–3 天 | 三平台 initdb + 建扩展 + 迁移跑通 |
| 1 骨架 | Tauri 壳 + sidecar + `go:embed` 静态资源 + 内嵌 PG + 本地存储 + 免登录；现有 UI 只读浏览跑通 | 1–2 周 | 桌面端可安装、可浏览公开与后台内容 |
| 2 后台任务 | 进程内队列 runner、reconcile ticker、重启续跑 | 1 周 | 知识构建与视觉导入完整可用 |
| 3 AI 集成 | `agentcli` 检测、`petrichor mcp` stdio、三种 CLI 适配、SSE 流式聊天、embedding 降级 | 2–3 周 | 无任何 Key 配置即可完成可追溯问答 |
| 4 交付 | 打包（dmg / msi / AppImage）、签名与 macOS notarization、tauri-updater 自动更新、崩溃日志 | 1 周 | 干净机器安装即用 |

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| pgvector 二进制未随 zonky 产物分发或平台缺失 | 阶段 1 阻塞 | 阶段 0 先行验证；兜底方案为自编译 pgvector 随包分发，或引导安装系统 PG（体验降级） |
| 三家 CLI 非交互协议 / flag 随版本漂移 | 聊天集成失效 | 适配器做版本探测 + 特性开关；协议调用封装在 `agentcli` 单层内，失败时给出明确指引 |
| 长任务被应用退出中断 | 导入任务丢失进度 | 复用 PG 状态 + reconcile 补偿 + 重启续跑；退出前提示进行中的任务 |
| Unicode / 空格路径、端口占用等平台差异 | 启动失败 | 阶段 0 三平台实测；端口动态分配 + 启动自检 |
| 未签名安装包被系统拦截 | 分发受阻 | 阶段 4 完成签名与公证；未完成前在下载页说明手动放行步骤 |
| 内嵌 PG 数据损坏 | 用户数据丢失 | 保留 pg_dump 定期备份入口；数据目录与知识导出（OKF）双通道 |

## 8. 待决策事项

1. 壳的最终选型确认（推荐 Tauri 2，若强烈倾向 Go 单进程可接受 Wails 3 beta 风险）。
2. 本地 token 回环加固是否纳入阶段 1（推荐纳入，成本低）。
3. 桌面版是否保留"配置云端模型"的高级入口（推荐保留 `aicore` 原能力作为可选，默认隐藏）。
4. pi CLI 的 MCP 与 one-shot 协议细节需在阶段 0 实测确认。
