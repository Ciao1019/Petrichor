# Agent 扩展配置与运行控制

这些能力由 Pi 工具循环调用，凭据和权限由 Go 管理。此次不增加 Langfuse 或其他评测平台。
实现任务及验证记录见 [任务清单](integration-tasks.md)。

## 外部 MCP Client

现有 `/api/mcp` 继续向外提供 Petrichor 工具。新增的 Client 消费外部 **Streamable HTTP** 服务，使用官方 `github.com/modelcontextprotocol/go-sdk v1.8.0`。

在 `apps/api/config.toml` 增加：

```toml
[[agent.integrations.mcp]]
name = "documents"
url = "https://your-mcp.example/mcp"
token = "服务端访问凭据"
read_tools = ["search", "read_document"]
write_tools = ["create_document"]
allow_users = false
timeout_seconds = 30
```

工具名必须以实际服务的工具目录为准。加载 `external` 技能后，助手通过 `list_external_tools` 查看服务和参数结构；读取走 `call_external_read_tool`，写入通过现有确认卡提交完整的服务名、工具名和参数。写操作不支持会话级免确认，也不自动重试。

配置的凭据属于站点服务账号，默认只有操作员能使用；`allow_users = true` 会把该服务白名单开放给所有登录用户，应只用于明确允许共享的服务。工具注解不能扩大管理员白名单。不同用户、对话拥有独立 MCP 会话；空闲 15 分钟释放，最多 64 个活跃连接。不提供任意 URL、任意命令、OAuth 自动登录、MCP resources/prompts 或交互式 elicitation；返回需要额外输入时明确失败。

## 文件化 Skills

```toml
[agent]
skills_directory = "agent-skills"
```

路径相对 `config.toml`。镜像已包含示例，使用绝对路径 `/app/agent-skills`，也可只读挂载自建目录。API 启动时校验助手技能，修改后重启 API；Worker 在构建时读取文档技能。

目录中每个 `SKILL.md` 使用标准 YAML `name`、`description` 和 Markdown 正文，扩展字段为：

```yaml
---
name: project-research
description: 项目资料研究与整理。
metadata:
  petrichor:
    title: 项目研究
    target: assistant
    dependencies: [knowledge, external]
    tools: [knowledge.read, mcp.read]
---
先读取来源，再核对并汇总，保留引用。
```

`assistant` 技能进入动态目录，模型可以直接加载自定义 ID。工具只能引用已注册 ID，依赖允许其他文件技能，未知依赖、循环依赖、重复 ID、覆盖内置技能、符号链接均拒绝。

`target: document` 的规则会附加到 Wiki 全文抽取主 Agent 和文档子任务，沿用其虚拟工作区及结果校验；不允许声明工具或依赖。技能是管理员维护的说明文件，不执行其中的脚本，也不自动读取链接文件。最多 64 个技能、单文件 64 KiB。

示例：`apps/api/agent-skills/research-note/SKILL.md`、`wiki-curation/SKILL.md`。

## 模型重排

```toml
[agent.integrations.rerank]
enabled = true
url = "https://api.jina.ai/v1/rerank"
api_key = "服务端凭据"
model = "jina-reranker-v2-base-multilingual"
timeout_seconds = 8
```

支持 Jina `/v1/rerank` 兼容协议：发送 `model/query/documents/top_n/return_documents`，验证返回的 `results[].index/relevance_score` 后排序。先经过现有用户权限过滤、混合召回与文章候选选择，最多发送 10 个候选，每个截断到 6000 字符；来源 ID 和引用不变。

连接失败、超时、索引重复、结果不完整时使用原有本地重排，诊断中保留降级原因。未配置时仍使用本地排序。开启外部重排会把这些候选正文发送到管理员选择的服务。

协议核对：[Jina 官方 OpenAPI](https://api.jina.ai/openapi.json)。

## 代码沙箱

沙箱是独立 Go 服务，在专用主机上调用 Docker。应用 API 只持有该服务的 HTTP 地址和访问凭据，不接触 Docker socket。

在工具主机执行：

```sh
docker build -t petrichor-sandbox:local apps/api/tools/sandbox
cd apps/api
# 参照 tools/sandbox/config.example.toml 创建 sandbox.toml，配置随机 token。
go run ./cmd/sandbox --config sandbox.toml
```

然后配置 API：

```toml
[agent.integrations.sandbox]
enabled = true
url = "http://127.0.0.1:8099/execute"
token = "与独立沙箱服务一致的至少32字符随机密钥"
timeout_seconds = 20
allow_users = false
```

容器部署的 API 需要填写可达的工具主机地址；跨主机连接使用私网和 TLS 反代。执行服务默认绑定回环地址，可通过独立配置的 `listen` 修改。不要公开无鉴权的 Docker API。

加载 `computation` 技能后支持 Python 标准库和 JavaScript 内置模块。每次执行创建新容器：无网络、无宿主挂载、只读根文件系统、非 root、移除全部 capabilities、禁止提权、1 CPU、256 MiB 内存、64 个进程、64 MiB 临时目录、最多 60 秒。服务最多同时执行 2 个任务，超时及正常结束都清理容器。stdout/stderr 各最多 128 KiB，返回退出码与截断标记。文件及会话不会在下一次执行中保留。

## 浏览器执行

提供独立的 `compose.agent-tools.yaml`，参照 [Playwright MCP 官方说明](https://github.com/microsoft/playwright-mcp) 配置。启动前可将镜像锁定为部署时核验的 digest：

```sh
docker compose -f compose.agent-tools.yaml up -d
```

服务默认仅通过本机 `127.0.0.1:8931` 访问，API 配置示例在 `config.example.toml`。必须保留 `--isolated`，不启用 `--shared-browser-context`，不挂载真实用户的浏览器资料目录。通过代理跨主机访问时配置认证和对应的 allowed-hosts；白名单按 HTTP Host 匹配，非默认端口必须一并填写，例如 `browser:8931`。

浏览器复用 `external` 技能：发现工具后进行导航、查看页面、点击、输入和切换页面；样例只把 `browser_snapshot` 列为只读，其余交互需要确认。HTTP 会话按用户/对话隔离，但第三方 MCP 服务仍须正确实现会话隔离。浏览器主机应与应用数据库网络隔离；Playwright 的 allowed-origins 不应当作网络安全边界。登录状态仅在本次隔离会话中保留，闲置关闭或服务重启后重新登录。

## 运行中补充与检查点恢复

助手对话运行时显示“补充要求”，可选择当前步骤结束后处理（Pi `steer`）或本轮工作结束后处理（Pi `followUp`）。每轮最多 32 条，每条 4000 字符。补充要求先落数据库，再交给 Pi；在最后一轮之后抵达的要求会保留为可恢复任务。

`202609220001_agent_continuation.sql` 新增检查点表。每个对话保存最近一次任务的模型引用、原始消息、目标、计划、技能、证据、工具观察、累计预算与补充指令序号；凭据及角色不写入，恢复时重新鉴权、解析模型并核对聚焦资源归属。

每次模型结束和工具执行前后持久化。断线、取消、重启后显示“从检查点继续”；进程崩溃时最多等待 60 秒租约过期。以新 Run 继续，已完成的工具结果作为上下文保留，不重新执行已完成的调用。执行中的只读调用可重新计划；执行中的写操作或委派结果未知时拒绝自动恢复，提示核实外部状态。

恢复不是自动后台续跑，也不恢复浏览器进程或沙箱文件。当前模型调用的中间文本和未完成文档子任务不能逐 token 恢复。工具调用总预算与 token 计数继续保留，每次显式恢复重新计算本次执行时限。新消息会取代旧检查点。

接口均使用现有登录鉴权：`POST /api/assistant/run/control`（`threadId/mode/text`）、`POST /api/assistant/run/recovery`（`threadId`），恢复通过 `/api/assistant/chat` 的 `resume: true`。同一对话租约只能有一个执行者，旧执行者失去租约后不能覆盖新检查点。
