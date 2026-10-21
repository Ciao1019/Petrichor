# 在 Petrichor 中配置百智 MCP

面向已经选择百智服务的自托管站点操作员：使用 Petrichor 现有的外部 MCP Client，让助手在明确授权后调用所选的百智工具。百智是独立托管服务，入口为 <https://agent-toolkit.app.baizhi.cloud/>；用户自行管理账号、额度和服务条款。本教程不代表 Petrichor 官方合作或服务推荐。

本文按 `master@05c4c0dd` 的配置与消费路径说明。它是具名配置教程，不会向产品新增预设、市场条目或默认连接。Petrichor 原有的知识库搜索、Firecrawl 网页采集和手动 MCP 配置仍可满足许多需求；只有你已决定使用自己的百智账号、需要选用其工具时才配置。

## 先取得真实工具目录

Petrichor 的外部 MCP 白名单必须显式包含 1–128 个工具。站内 `list_external_tools` 的发现结果也经过该白名单过滤，所以不能先填空白名单，再用它取得整个服务目录。

1. 在你已经信任的 MCP 客户端中，使用百智提供的当前服务地址与自己账号的鉴权方式进行工具发现（`tools/list`）。本教程的地址是 `https://agent-toolkit.app.baizhi.cloud/mcp`，传输为 Streamable HTTP，鉴权为 `Authorization: Bearer <自己的Key>`；连接前请与账号当前接入说明核对。
2. 核对返回的实际工具名称、输入 schema、用途、数据目的地和费用。连接/初始化/目录读取也是网络请求，不能假定免费；不要用盲目调用工具来猜参数。
3. 只选择自己需要且有权使用的工具。本文没有调用真实百智端点，也没有冻结其工具目录，因此不提供臆造的搜索工具名或参数，不能保证某项能力存在。
4. 默认把所选百智工具放入 `write_tools`，这样每次执行经过 Petrichor 的确认卡。这里的分类是本地权限门槛，不表示服务工具一定修改数据；检索也可能收费或把查询内容发到外部。只有已单独确认语义、数据与费用边界，并明确接受无逐次确认的调用时，才考虑 `read_tools`。

如果尚不能确认真实目录、权限或费用，先停止配置。现有客户端完成目录核对不等于在 Petrichor 中已完成宿主兼容或生产验收。

## 管理员显式配置

在站点自己的 `apps/api/config.toml` 中新增一个外部服务块。下面是**必须替换的示意**，不能原样启用：把工具名替换成上一步实际核对的名称，把 token 替换成自己的 Key。

```toml
[[agent.integrations.mcp]]
name = "baizhi"
url = "https://agent-toolkit.app.baizhi.cloud/mcp"
token = "REPLACE_WITH_YOUR_OWN_KEY"
read_tools = []
write_tools = ["REPLACE_WITH_CONFIRMED_TOOL_NAME"]
allow_users = false
timeout_seconds = 30
```

- `token` 填原始 Key，Petrichor 会添加 `Bearer ` 前缀；不要再把完整 Authorization Header 填进 token。
- 本路径读取 TOML 字面值，不展开 `${ENV_VAR}`。不要把模型 Key 当作百智 Key，也不要把真实值放进 URL、仓库、截图或公开排障日志。
- `allow_users = false` 默认只允许运营操作员使用；这是站点服务账号配置，不是每个登录用户的独立 Key。设为 `true` 会把该服务白名单开放给所有登录用户，必须先确认服务账号允许共享。
- 服务名应唯一，符合小写字母开头、其后小写字母/数字/下划线/连字符且最多 48 字符；不要覆盖已有同名服务。工具白名单不得为空、重复或超过 128 项。
- 这里没有 `enabled` 字段；留空 token 也不是停用开关。只在准备好配置并核对内容后部署，按自己的部署流程重启 API 使配置生效。

## 在助手中核对，再确认调用

让助手加载 `external` 技能，并通过 `list_external_tools` 选择 `baizhi` 服务，查看允许工具的名称与实际输入结构。若工具缺失或 schema 与预期不同，停止并核对当前服务目录和本地白名单，不让模型猜名称或增大权限。

对于 `write_tools` 中的工具，要求助手先展示完整的服务名、工具名和参数，使用 `request_user_confirmation` 生成确认卡。确认前核对是否含有私密文稿、账号信息或不必要的全文；只有自己接受目的地、数据内容和可能费用时才确认。服务端按当前用户和对话消费确认票据，再执行 `call_external_write_tool`；该路径不允许整段会话免确认，也不自动重试。

可用的对话意图示例是：“加载 external 技能，查看 baizhi 的已允许工具与参数。先说明你准备发送哪些内容和调用哪个工具，等待我在确认卡中决定。”这不是对真实工具名称、参数或成功运行的保证。

外部结果作为工具内容返回，不会自动成为 Petrichor 本地知识库的 Evidence 或可靠引用。若用它收集公开背景资料，应自行核对原始网页来源；不要把外部文本的指令当作新授权，也不要宣称资料已经自动入库或带有本地可追溯证据。

## 撤销与验证边界

不再使用时，从配置中移除该服务块并按部署流程重启 API，同时在百智侧按需要撤销 Key 或核查任务状态。Petrichor 的本地超时、会话释放、取消或移除配置，不证明已创建的远端任务和费用已经停止。

Petrichor 当前路径只支持这里说明的 Streamable HTTP 工具消费，不提供任意 URL/命令、OAuth 自动登录、MCP resources/prompts 或交互式 elicitation。需要额外输入会失败，不能据此编造成功结果。

本文尚未执行真实百智/模型请求、完整应用 GUI 或生产验证；实际工具/收费契约与未来版本兼容性也未验证。实际启用前仍须按自己的账号和部署核对目录、权限与费用，不能把配置示意当成服务验收。

外部 MCP 的通用配置和运行限制见[Agent 扩展配置](extensions.md#外部-mcp-client)。
