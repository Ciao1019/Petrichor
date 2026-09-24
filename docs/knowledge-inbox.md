# 随笔

后台首页 `/dashboard` 默认进入 `/dashboard/inbox`。用户可以先记录，再决定内容属于哪个知识库；记录时不必填写标题或选择文件夹。

## 使用流程

1. 首页与编辑弹窗复用文章详情的 Plate 富文本编辑器，支持完整工具栏、斜杠菜单、表格、颜色、批注与媒体上传；可添加标签，点击「记下来」或按 Cmd / Ctrl + Enter 保存。
2. 在卡片流中搜索正文，按标签筛选、置顶、编辑和删除；通过「待整理 / 已归档 / 全部随笔」切换范围。
3. 点击「归档到知识库」，确认文章标题、知识库和文件夹。归档后正文、图片引用和标签进入正式文章。
4. 从「已归档」中的「查看文章」继续编辑。后续需要检索或问答时，使用知识库现有的知识构建入口；归档本身不调用模型。

## 保存与归档边界

- 随笔仅创建者可读写；未归档内容不进入公开知识门户或 Agent 检索。
- Markdown 正文最多 20,000 个字符，标签最多 20 个，每个最多 80 个字符。媒体沿用文章编辑器的上传限制和私有签名访问能力；待上传或上传失败的附件需完成、重试或移除后才能保存。
- 同时保存 Markdown、富文本结构与批注元数据；草稿、卡片预览、再次编辑和归档均保留格式。提交时直接读取编辑器快照，避免延迟同步漏掉最后一次输入。
- 新建草稿按用户隔离，保存在当前浏览器；保存失败保留输入。草稿不是跨设备同步，编辑已有随笔时的未保存修改只保留在当前弹窗。
- 新建请求带幂等标识，重复请求不会新增记录；编辑和删除校验版本，防止过期页面覆盖内容。
- 归档在同一数据库事务中创建文章、关联标签并更新随笔状态；并发归档只生成一篇文章。
- 归档后保留只读随笔快照，后续文章修改不会反向更新快照。删除快照不删除文章；删除文章后仍保留随笔原文。
- 附件引用检查同时覆盖随笔与知识库文章，避免清理文章图片时误删仍被随笔引用的图片。
- 静态 Demo 支持记录、编辑和归档演示，已保存内容刷新即重置。

## Jev 智能归档推荐

归档弹窗中的「获取推荐」会使用 TypeSafe Jev 分析已保存的随笔，推荐一个知识库、其下的
文件夹以及最多 5 个已有标签。打开弹窗只检查是否启用，不调用模型；每次主动请求最多进行
两次判断：知识库与标签共享第一轮请求，确定知识库后再判断文件夹。

- 「一键采纳」把建议填入表单，保留用户修改的标题和原有标签；可以继续改位置或移除标签。
  最终点击「确认归档」才创建文章，原随笔的正文和标签快照保持不变。
- 知识库判断不明确时只展示最多三个候选；没有合适位置时明确说明，可关闭弹窗保持待整理。
  文件夹判断不明确或第二轮失败时推荐根目录，并提醒手动核对。
- 推荐服务未启用、超时或返回错误都不影响手动归档；不会自动重试收费请求。
- 候选由服务端按当前用户读取，模型输出只能选择已有候选；归档时再次检查随笔版本、
  知识库与文件夹归属、标签是否属于该用户。标签来自其随笔和文章，不创建新标签。
- 推荐最多参考最近更新的 100 个知识库、40 个常用标签及所选库的 100 个文件夹；根据请求
  字节预算还可能缩小候选范围，并在界面提示。超过 4,000 字的随笔取前 3,000 字和后 1,000 字，
  明确提示取样，原文不变。首版建议用于分类范围适中的个人知识库。
- 同一 API 进程最多同时处理 8 个推荐请求，每个用户最多 1 个。服务重启清空并发状态，
  多副本部署时该上限分别作用于各进程。

在 Go 服务端 `apps/api/config.toml` 增加以下配置，然后重启 API。密钥只放在服务端，
不写入浏览器配置或仓库；普通 CHAT 模型绑定不影响此功能。

```toml
[typesafe]
enabled = true
base_url = "https://api.typesafe.ai"
api_key = "填写你的 TypeSafe API Key"
model = "jev-1.13.0"
timeout_seconds = 20
min_confidence = 0.7
tag_threshold = 0.85
```

该超时覆盖读取候选及两轮判断。启用并点击推荐时，会向配置的 TypeSafe 服务发送这条随笔的
文本、标签及候选分类说明；不会发送其他文章正文、图片二进制或富文本批注。阈值仅为试用起点，
置信度不等于正确率；中文效果需要用实际资料验证。生产建议固定模型版本后再调整阈值。

新增登录接口为 `POST /api/inbox/recommendation/config` 和 `POST /api/inbox/recommendation`；
后者接收 `{ id, version }`，返回建议、候选、标签、限制说明及用量。
原归档接口增加可选 `tags` 字段：省略时沿用随笔标签，空数组表示文章不带标签。

第一版不新增数据库表。服务端以 `inbox_recommendation_generated` 与
`inbox_recommendation_archived` 结构化日志记录生成和最终采纳情况，不记录随笔正文或标签文本。
归档回执签名绑定用户、随笔、版本和建议，有效期 30 分钟；它只用于统计，不授予任何写权限。
`outcome=accepted` 表示最终位置和标签与建议一致，`modified` 表示调整过，`no_suggestion`
表示没有确定建议；`applied` 记录用户是否点击采纳。汇总按 `userId/noteId/articleId` 去重，
仅在携带有效回执且完成归档的记录中计算采纳率；不统计关闭弹窗且未归档的用户。

`/demo` 提供明确标注的本地推荐示例，可体验采纳、修改与归档；不调用 Jev，也不产生费用。
接口封装位于 `internal/typesafe/`，业务位于 `internal/kb/inbox_recommendation*.go`。

官方依据：[API](https://docs.typesafe.ai/api)、[模型](https://docs.typesafe.ai/models)、
[已知限制](https://docs.typesafe.ai/model-jaggedness/jev-1.13)。

## 实现与迁移

前端位于 `apps/web/src/features/pages/inbox/`，API 类型在 `apps/web/src/lib/api-inbox.ts`。
Go 路由位于 `apps/api/internal/routes/inbox.go`，业务实现位于 `apps/api/internal/kb/inbox*.go`。
登录后的 POST 接口为 `/api/inbox/list`、`create`、`update`、`pin`、`delete`、`archive`。

迁移 `202609160002_inbox_rich_content.sql` 为随笔新增可空的 `content_json`、`content_meta_json` 字段；旧记录继续从 Markdown 恢复，无需回填。
迁移 `202609160001_inbox_notes.sql` 新增 `petrichor_inbox_note` 表和相关索引，不回填或改写现有文章。
应用发布后，Go 服务启动时会按现有 Goose 流程执行迁移；前后端应同步更新。

## 验证

```bash
cd apps/web
bun run test src/features/pages/inbox/InboxComposer.test.tsx src/features/pages/inbox/InboxArchiveDialog.test.tsx src/lib/demo/demo-inbox.test.ts

cd ../api
go test ./internal/typesafe ./internal/config ./internal/kb ./internal/routes ./migrations
```

数据库集成测试默认跳过。需要一套启用 pgvector、允许创建数据库的本地专用 PostgreSQL；
仅接受回环地址上的 `petrichor_inbox_test` 数据库，不读取项目 `config.toml`。
测试会创建临时数据库、应用迁移，并在结束时删除临时库。

```bash
PETRICHOR_INBOX_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/petrichor_inbox_test?sslmode=disable' \
  go test ./internal/kb -run TestInbox -count=1
```

覆盖用户隔离、版本冲突、重复提交、并发归档、事务回滚、归档后删除记录保留文章，以及图片引用保护。

真实 Jev 冒烟测试默认跳过。在本地 `config.toml` 配好 TypeSafe 后，可显式运行：

```bash
PETRICHOR_INBOX_JEV_LIVE_TEST=1 go test ./internal/kb -run '^TestInboxRecommendationJevLive$' -count=1 -v
```

该测试只发送合成的中文 React 笔记和分类，最多调用两轮真实接口，会产生 API 用量；不连接数据库。
它验证密钥、协议及一个中文分类样例，不代表真实资料的整体推荐准确率。
