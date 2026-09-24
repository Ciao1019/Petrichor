# 前台统一问答部署

2026-09-23 已发布至 <https://wl.do/ask>，发布标识 `publicqa-20260923-v2`。

## 与后台对齐

- 移除前台「普通问答 / Wiki 问答」切换、对应状态和请求头。
- 服务端只有一套 Pi 工具与提示词。`search_public_documents` 在同一次搜索中召回公开原文与安全公开 Wiki，合并全文、语义结果并排序。
- Pi 根据返回的来源类型选择原文、章节或 Wiki 深读，可在同一轮回答中交叉引用；仍只有文档问答能力。
- 移除废弃的分模式检索、Wiki 概览和重复阅读入口；旧客户端传入的模式请求头不再影响检索范围。
- 检索卡片统一显示资料，并标出「原文 / Wiki」。目录卡同步实际返回的 `items` 和路径数组；清理已不开放的计划、进度、表格工具展示。
- 演示回放同步统一工具协议。所有公开可见性、配额、引用核对及 Pi 预算限制继续生效。

## 验证

- 工作区定向 Go 测试、TypeScript 检查和定向 ESLint 通过。
- 当前线上 API/Web 源码仅叠加本次 9 个文件，再执行 `go test -p 1 ./...`、`go vet ./...`、`bun run typecheck`、定向 ESLint 和生产构建，全部通过。构建保留既有大 chunk 提示。
- 新增回归测试：同一公开搜索工具同时返回原文和 Wiki；结果携带正确的阅读标识，两类来源都进入本轮引用证据；旧分模式工具不再暴露。
- ego-browser 检查生产构建：1440px 桌面与 390px 手机，明暗主题，均无模式切换和横向溢出。通过本地 SSE 夹具验证合并卡片、继续提问、Wiki 结果跳转及无旧模式请求头；控制台无错误。
- 本地既有演示作者资料缺字段会使 `PublicSiteAuthor` 报错，因此界面验收使用独立生产构建、公开站点资料与本地 SSE 夹具，未修改该无关组件。
- 上线后在真实浏览器提问「第一次使用 Mole 清理前应该先做什么」，成功完成检索、原文核验、回答和引用；接口 200，控制台无错误。
- 真实 API 提问 CED/Prefill：同一次搜索返回 `article` 与 `wiki`，Pi 阅读原文及 Wiki，并生成 1 个原文与 3 个 Wiki 来源引用；无工具错误，SSE 正常结束。
- 本次未调整公开问答开关；真实验证时开关已由用户开启。

## 发布与恢复

- 基线：API `publicqa-20260923-v1`；Web `inbox-20260923-v1`。
- 只叠加 6 个公开 QA Go 文件（含 3 个测试文件）和 3 个前台问答/回放文件。Worker 未重启，配置摘要不变，未新增或执行数据库迁移。
- API 镜像：`petrichor-api:publicqa-20260923-v2`，ID `sha256:f207ec5bc81a3e017ad64bc399bd6db206b64e645d32fd9e2ea4ec072a6a5af6`。
- Web 镜像：`petrichor-web:publicqa-20260923-v2`，ID `sha256:ccbeb75d5b18623df0d3f2762c9684482665d5cd3b760110f0bf876aa76fcc0b`。
- 源码、文件摘要清单及构建/部署日志：`/opt/petrichor/releases/publicqa-20260923-v2`。
- 原 Compose override、容器记录和配置摘要：`/opt/petrichor/backups/publicqa-20260923-v2`。
- 恢复命令：`python3 /opt/petrichor/releases/publicqa-20260923-v2/rollback.py`。仅当 API/Web 仍为本次版本时替换镜像，保留其他服务。

## 最终回答去重补丁

联合问答实测发现，工具轮中的模型正文会提前输出，展示引用后的最终总结又产生一份答案。
公开 Pi SSE 现与后台一致：工具轮草稿仅进入模型上下文，只有不再调用工具的最终答案才输出给用户；
提示词同步要求先展示引用再输出最终答案，并使用少量核心词检索。

- 新增真实 Pi 回归：模型先输出草稿并调用工具，再输出最终回答，SSE 必须只有一组正文且不含草稿。定向测试与 `go vet` 通过。
- 补丁上线后实测「CED 是什么」：一次统一搜索同时命中 `article` 与 `wiki`，随后阅读 Wiki、展示来源并回答；HTTP 200、无工具错误、SSE 只有一个 `text-start`，正常 `finish / DONE`。
- 最终 API 镜像为 `petrichor-api:publicqa-20260923-v3`，ID `sha256:20e0d96021f955a536a8cdce172f47ac24b85e0547a591d885f9ffce05cc7e38`；Web 保持 `publicqa-20260923-v2`。
- 补丁仅叠加 `qa.go`、`qa-pi.go`、`qa_test.go`，发布与备份目录分别为 `/opt/petrichor/releases/publicqa-20260923-v3`、`/opt/petrichor/backups/publicqa-20260923-v3`。
- 若需完整退回统一问答更新前，先运行 v3 目录的 `rollback.py`，再运行 v2 的 `rollback.py`；两者均会检查当前镜像避免覆盖后续发布。
