# 随笔网页采集

随笔顶部切换「随手写 / 网页采集」，两侧草稿相互独立。2026-09-22 起，页面只提供「收藏原文 / AI 整理」两个用途，默认收藏原文。

## 已接通的流程

- 粘贴网址 → 预览内容 → 保存到随笔。支持一次最多 10 个网址，每篇独立处理；任务在后台运行，可以取消或重试。
- 「收藏原文」保留正文和来源，不调用 AI。「AI 整理」生成摘要和要点，同时独立保留完整原文；优先使用用户 CHAT 模型，没有绑定模型时按服务能力使用 Firecrawl AI。
- 入口移除素材收集、主题摘录和抓取参数表单。新请求固定采集主要正文，不抓取截图；旧输入草稿保留网址和整理意图，技术参数恢复默认值。
- 预览以文章为主，支持切换完整原文、编辑正文；想法和标签按需展开。保存后明确显示成功状态。
- 追加到随手写草稿、下载原文、AI 重新整理、重新采集放在更多菜单；重新采集会消耗采集用量，重新整理只消耗模型用量。追加保留原有节点和批注，支持编辑器撤销。
- 完整原文独立保存在私有任务快照中，并转存为 Markdown 附件。随笔保持 20,000 字上限；超长正文不默认塞进随笔，界面明确提示「保存来源到随笔」，仍可阅读、下载完整原文或用 AI 整理。
- 历史记录默认折叠，支持重新打开结果与同网址提示。历史快照、附件和网页差异仍可访问，来源独立关联随笔并在归档时复制。
- 未保存的结果、失败记录和处理中任务均可在预览或历史列表中删除，操作前确认；失败时保留内容并允许重试。已被随笔或文章引用的来源不允许删除。
- 服务端保留现有采集协议与 Agent 的 `research.capture` / `research.capture_result` 能力。删除功能通过新增 `deleted_at` 标记隐藏记录，不自动删除任何历史数据。

## 2026-09-22 界面精简验收

- 相关 5 个测试文件、18 项用例通过，覆盖原文保存、AI 笔记与原文切换、失败重试、请求标识、历史来源回访、无模型可用、输入法确认和超长文章。
- Web TypeScript、改动文件 ESLint、生产构建与 800 行限制检查通过；沿用已有组件，无新增运行时依赖。
- 演示模式实际完成原文采集保存、AI 整理保存、补充想法、更多菜单和错误网址恢复；检查 1440px 桌面、390px 窄屏以及明暗主题，无横向溢出。
- 未调用真实 Firecrawl 或真实模型。生产构建仍有依赖外部化、dashjs 模块格式与大 chunk 提示，本次没有调整这些依赖。

## 2026-09-22 删除功能验收

- 相关 7 个前端测试文件、24 项用例通过，包含取消确认、失败重试、草稿保留与清理、已保存来源保护和迟到列表过滤。
- 隔离 PostgreSQL 集成测试通过，覆盖全部采集状态删除、用户隔离、幂等、额度保留、Worker 防复活、已删除来源拒绝保存，以及真实行锁下的保存/删除并发。
- Web TypeScript、定向 ESLint、生产构建、文件行数检查以及采集、随笔、路由相关 Go 测试与 vet 通过。
- 浏览器演示模式验证桌面与 390px 手机视口：取消不删除，确认后退出预览并移除历史，弹窗无横向溢出。未操作真实采集数据或调用付费服务。

## 启用

API 与 Worker 使用相同的服务端 TOML 配置。在 `apps/api/config.toml` 中按 `config.example.toml` 的 `[firecrawl]` 节填写：

```toml
[firecrawl]
enabled = true
base_url = "https://api.firecrawl.dev"
api_key = "填写你的 Firecrawl 密钥"
screenshot = true
actions = true
ai_formats = true
timeout_seconds = 120
concurrency = 4
per_user_concurrency = 2
daily_limit = 50
max_batch = 10
```

自托管可修改 `base_url`，按实际验证结果开启截图、页面动作与 AI 格式。密钥只保存在服务端配置文件，配置接口不返回密钥。仅启用服务不发起收费调用。

前往模型设置为「对话」用途绑定模型；没有模型时用户可选择「仅收藏原文」或已启用的 Firecrawl 内置 AI。对象存储复用已有 S3 或本地存储配置。

新增迁移 `202609170001_inbox_capture.sql` 创建采集记录与来源关联表。部署时由 API 现有 Goose 流程执行，随后启动统一 Worker。功能需要数据库、Redis 和 Worker，不能只启动 Web 静态资源。

本次开发没有读取或修改真实密钥、没有迁移现有业务数据库，也没有实际调用收费 Firecrawl Cloud。测试使用隔离数据库与本地上游契约服务；`/demo` 使用明确标记的内存示例。

## 服务端接口

接口均复用登录鉴权与当前用户隔离：

| POST 接口 | 用途 |
| --- | --- |
| `/api/inbox/capture/config` | 可用能力、模型状态、每日任务额度 |
| `/api/inbox/capture/create` | 按 clientId 幂等创建单条或批量任务 |
| `/api/inbox/capture/lookup` | 查询同网址已有快照 |
| `/api/inbox/capture/list` | 分页读取当前用户的任务记录 |
| `/api/inbox/capture/result` | 原文、整理结果与短期资产访问地址 |
| `/api/inbox/capture/cancel` | 停止尚可停止的处理 |
| `/api/inbox/capture/delete` | 传入 `{id}`，幂等删除未被随笔或文章引用的采集；跨用户返回 404，已有引用返回 409 |
| `/api/inbox/capture/regenerate` | 复用已保存原文，重新用用户模型整理 |
| `/api/inbox/create` | 原有随笔保存接口，增加 `captureIds`，在同一事务中关联来源 |

检查更新调用 `capture/create`，传 `previousId`、相同 URL 和新 `clientId`；强制重新采集。批量由本地队列拆成独立 Scrape 请求，不依赖 Firecrawl Batch 结果的短期保留时间。

## 状态、费用和恢复

状态为 `queued → scraping → processing → ready`，异常终态为 `partial / failed / cancelled`。是否保存由来源关系计算，不改变原文快照。数据库记录充当队列 outbox，每分钟对账未排入 Redis 的任务。

Worker 每 10 秒续租并检查取消状态。正文返回后先落库，再转存资产、调用模型；进程在抓取阶段失联时标为失败，不自动重发执行结果未知的收费请求。进程在后处理阶段失联时从原文恢复。模型调用和媒体下载可能在恢复时重复，任务用量展示已确认的返回数据。

普通网页基础请求预估 1 Firecrawl credit；内置 JSON 或 highlights 另加 4。模型 token 单独展示；PDF、特殊站点、错误页面和缓存可能产生不同费用。没有可靠用量字段时显示「未确认」，不假造精确费用。

当前保留采集历史供用户长期追溯，不自动删除历史原文。定时网页监控、提醒和跨来源研究仍通过现有 Agent 的明确任务处理，本功能没有自动开启收费监控。

手动删除采用逻辑删除（迁移 `202609220002_inbox_capture_delete.sql`）：已删除记录不再出现在列表、同网址提示和结果接口中，不能再次关联随笔，正在运行的任务停止后续处理。删除不返还每日任务额度或已发生的费用，也不删除可能被其他快照复用的附件；数据库保留记录，页面不提供恢复入口。保存与删除使用同一来源行锁，避免并发删除破坏已保存的来源；Worker 更新和续租排除已删除记录，防止迟到结果重新出现。

## 验证

定向 Go 测试覆盖协议、费用选项、网址限制、原文匹配、分段无丢失和差异对比。隔离数据库测试覆盖迁移、请求幂等、任务重放、用户隔离、事务保存、取消、错误页与崩溃恢复。

本次验收通过前端 76 个文件、509 项测试、TypeScript 检查、改动文件 ESLint、生产构建及 Go 测试与 vet。浏览器以演示数据检查桌面、390px 窄屏和深色模式，完成采集、编辑、追加及撤销、保存、来源回访与重复跳转。未进行真实 Firecrawl 或真实模型端到端调用。

仓库全量 ESLint 仍有既存的 4 个未使用变量错误，位于 `SiteFilingConfigPage.tsx`、`UserManagementPage.tsx` 和 `settings/SettingsLayout.tsx`，不属于本次采集实现。

```bash
cd apps/api
# 仅接受回环地址上的专用 petrichor_inbox_test，测试内部再创建并清理独立子库。
PETRICHOR_CAPTURE_TEST_DATABASE_URL='postgres://...@127.0.0.1:PORT/petrichor_inbox_test' go test ./internal/capturesvc -run TestCaptureDatabaseLifecycle
```
