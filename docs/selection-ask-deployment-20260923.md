# 前台划词问 AI 部署记录

2026-09-23 已部署至 <https://wl.do>，服务器 `216.23.81.56`，版本 `selection-ask-20260923-175852`。

## 发布内容

- 相比 `qa-toc-20260923-170605`，14 个文件发生变化，包括新增公开划词接口、前端工具栏、文章/Wiki 接入和对应测试。
- 文章和 Wiki 正文选区支持解释、翻译、复制及自定义提问，回答通过 SSE 展示；接口复用公开文档访问校验，并独立限制请求额度。
- 当前工作区 1,529 个发布文件经 SHA-256 校验后构建；切换前再次核对快照与工作区一致。
- 更新 API 和 Web。已确认 Worker 不依赖本次修改的 Go 包，保留其容器和启动时间；其他服务、业务配置、Caddy 和数据卷保持原状。
- 无依赖或数据库结构变更；新 API 镜像上线前核对 13 个迁移全部已执行。

## 验证

- Web 类型检查、API 严格类型检查及本次前端文件的 ESLint 通过。
- 划词组件、公开 Wiki 路由及 SSE API 客户端相关 3 个测试文件、16 项测试通过（`--maxWorkers=2`）。
- `go test -p 1 ./internal/publicapi/... ./internal/routes/...` 和对应 `go vet` 通过。
- 文件行数、Go 请求 Context 及 `git diff --check` 通过。
- API / Web 生产镜像构建成功，Web 保留既有依赖外部化、dashjs 模块格式及大 chunk 提示。
- API healthy，API / Worker / Web 均运行、重启计数为 0。Caddy 曾记录一条 `/api/public/qa/chat` 请求中断的 warn，不属于本次划词接口。
- 公网首页、`/ask`、`/wiki`、`/about`、`/dashboard/inbox`、`/healthz`、`/readyz` 均返回 200；首页及 44 个入口、文章和 Wiki 相关资源摘要与新镜像一致。
- 新接口空请求返回 `400 / 请先选中一段文字`，确认路由和参数校验生效。
- ego-browser 在真实公开文章中选择正文并点击解释：HTTP 200，70 个文本帧，正常 `[DONE]`，无错误帧，最终显示 457 字符回答及本小时剩余 19/20 次额度。首次可见回答等待超过 25 秒，后续完整请求正常完成；本次未调整模型延迟。
- 1440px 桌面划词入口正常；390px 手机回答面板宽 352px、无横向溢出。公开 Wiki 的划词入口、输入框聚焦与 Esc 关闭通过，未额外发送 Wiki 模型请求；捕获的浏览器错误为 0，验收页面已关闭。
- 未重复运行全量前端 lint；此前 3 处既有未使用代码错误未纳入本次修改。

## 镜像与恢复

- API：`petrichor-api:selection-ask-20260923-175852`，ID `sha256:385b464bea77fc0582b8d2e09a2359f038b59ff57ebf2fae9928b99240fdd351`。
- Web：`petrichor-web:selection-ask-20260923-175852`，ID `sha256:042ed462717afc567cc7e01731f047f066ec2e2bbe3ff02a9a8a726d5ac6711a`。
- Worker 继续使用 `petrichor-api:chatfix-20260923-164821`。
- 服务器发布源码、构建、部署和核验记录：`/opt/petrichor/releases/selection-ask-20260923-175852`。
- 原配置及容器/镜像记录：`/opt/petrichor/backups/selection-ask-20260923-175852`，仅 root 可访问。
- 回滚命令：`python3 /opt/petrichor/releases/selection-ask-20260923-175852/deploy.py rollback`。脚本校验配置未被后续发布修改后，恢复之前的 API 与 Web；不还原数据库、不删除数据卷。
