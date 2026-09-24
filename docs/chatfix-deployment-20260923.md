# 问答滚动与工具预算提示部署记录

2026-09-23 已部署至 <https://wl.do>，服务器 `216.23.81.56`，发布标识 `chatfix-20260923-164821`。

## 发布范围

- 当前工作区的 1,521 个发布文件打包并校验摘要，相比线上 `ratelimit-20260923-v1` 仅有 7 个文件变化，包含对应测试。
- 前台问答容器使用完整高度，修复消息区内部滚动的高度传递。
- 移除运行中的剩余工具调用次数提示，只在工具预算真正耗尽时提示继续提问；历史 warning/resolved 提示隐藏。
- 更新 API、Worker、Web。生产 Compose 除这三个服务的镜像外无变化；其他服务容器、业务配置、Caddy 和数据卷保持原状。
- 新镜像切换前核对 13 个迁移全部已执行，本次无数据库结构变更。

## 验证

- `bun run typecheck`、`bun run typecheck:api-strict` 通过。
- 助手工具展示、运行控制、前台对话历史和指纹相关 4 个测试文件、12 项测试通过（`--maxWorkers=2`）。
- `go test -p 1 ./internal/assistantsvc/... ./internal/publicapi/...` 与对应 `go vet` 通过。
- 本次 3 个前端文件的 ESLint、文件行数检查、Go 请求 Context 检查和 `git diff --check` 通过。
- 全量 ESLint 仍有 3 处此前已存在的未使用代码错误：`SiteFilingConfigPage.tsx` 的 `ShieldCheck`，`UserManagementPage.tsx` 的 `UserCog` 和 `handleDelete`。本次未修改这些文件。
- API / Worker / Web 生产镜像构建成功。Web 保留既有依赖外部化、dashjs 模块格式及大 chunk 提示。
- 上线后 API healthy，三个服务均运行且重启计数为 0，启动日志无 error / panic / fatal。
- 公网 `/`、`/ask`、`/wiki`、`/about`、`/dashboard/inbox`、`/healthz`、`/readyz` 返回 200；首页与 32 个入口及问答相关资源的 SHA-256 和新镜像一致。
- ego-browser 检查线上问答入口：1440×900 桌面、390×844 手机，输入框可见、无横向溢出，捕获的浏览器错误为 0。未发起真实模型问答，未验收长对话的完整业务流程。

## 镜像与恢复

- API / Worker：`petrichor-api:chatfix-20260923-164821`，ID `sha256:a5cbc11f440451f7a84ac7e53ac973f18df64f45a13ac0cb7bc7f19f72dbc0ce`。
- Web：`petrichor-web:chatfix-20260923-164821`，ID `sha256:66b89efb4b89b1803eca2d9a75c74652c4ac737828f07fe976e72e73cc32859d`。
- 服务器源码、摘要、构建和部署日志：`/opt/petrichor/releases/chatfix-20260923-164821`。
- 原配置及容器/镜像记录：`/opt/petrichor/backups/chatfix-20260923-164821`，仅 root 可访问。
- 回滚命令：`python3 /opt/petrichor/releases/chatfix-20260923-164821/deploy.py rollback`。脚本先校验 Compose override 未被后续发布修改，再恢复上版三个镜像；不还原数据库、不删除数据卷。
