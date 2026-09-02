# Agent 集成层：API Key、REST、MCP 与 Skill

Petrichor 的外部 Agent 集成层位于 `apps/api/internal/agentapi`。它和产品内的
`assistantsvc` Agent Runtime 是两套入口：外部客户端通过 API Key 调用 `/api/agent/**` 或
`/api/mcp`，产品内助手继续使用登录态和内部工具注册表。

## 1. 入口与路由

协议与发现入口：

```text
GET    /api/agent/manifest
GET    /api/agent/skill
GET    /api/agent/skill-pack
POST   /api/mcp
DELETE /api/mcp
```

- `manifest` 返回能力和鉴权说明；
- `skill` 按请求域名生成单文件 `SKILL.md`；
- `skill-pack` 仅在 `[agent].skills_directory` 指向非空可读目录时返回 ZIP，否则 404；
- `mcp` 是 Streamable HTTP MCP 入口，POST 和 DELETE 都需要 Agent API Key；无状态 DELETE 返回 204。

受保护 REST 能力：

| 分组 | 端点 | Scope |
| --- | --- | --- |
| 发现 | `GET /api/agent/capabilities` | 任意有效 Key |
| 知识库 | `POST /api/agent/knowledge-base/list` | `doc:read` |
| 知识库 | `POST /api/agent/knowledge-base/tree` | `doc:read` |
| 文件夹 | `POST /api/agent/folder/create` | `article:write` |
| 文章 | `POST /api/agent/article/list` | `doc:read` |
| 文章 | `POST /api/agent/article/create` | `article:write` |
| 文章 | `POST /api/agent/article/update` | `article:write` |
| 文章 | `POST /api/agent/article/delete` | `article:delete` |
| 文章 | `POST /api/agent/article/move` | `article:write` |
| 分享 | `POST /api/agent/article/share/info` | `share:write` |
| 分享 | `POST /api/agent/article/share/create` | `share:write` |
| 分享 | `POST /api/agent/article/share/revoke` | `share:write` |
| 检索 | `POST /api/agent/document/search` | `doc:read` |
| 检索 | `POST /api/agent/document/tree` | `doc:read` |
| 检索 | `POST /api/agent/document/semantic-search` | `doc:read` |
| 阅读 | `POST /api/agent/document/view` | `doc:read` |
| 问答 | `POST /api/agent/document/qa` | `qa:read` |
| AI | `POST /api/agent/article/summary/generate` | `ai:write` |
| AI | `POST /api/agent/article/mindmap/generate` | `ai:write` |
| Wiki | `POST /api/agent/wiki/page/list` | `wiki:read` |
| Wiki | `POST /api/agent/wiki/page/detail` | `wiki:read` |
| Wiki | `POST /api/agent/wiki/lint` | `wiki:read` |
| Wiki | `POST /api/agent/wiki/ingest` | `wiki:write` |

成功响应沿用 `{ code, msg, data }`，错误响应沿用 `{ code, msg, path, timestamp }`。

## 2. API Key 与 scope

Key 格式为：

```text
ptc_live_<随机串>
```

数据库只保存 SHA-256 哈希与短前缀，明文仅在创建时返回一次。当前支持的 scope：

```text
doc:read
qa:read
article:write
article:delete
share:write
ai:write
wiki:read
wiki:write
```

鉴权链路：

1. 从 `Authorization: Bearer ...` 读取 Key；
2. 哈希并查询 `petrichor_agent_api_key`；
3. 校验是否已撤销、过期；
4. 校验端点要求的 scope；
5. 用 Key 所属用户 ID 执行业务查询，保持租户隔离；
6. 写回 `last_used_at`，并记录调用审计。

## 3. 调用审计

每次通过有效 Key 进入能力处理器的调用都会写入 `petrichor_agent_call_log`：

```text
user_id
api_key_id
api_key_prefix
method
path
ip
user_agent
request_json
response_json
status_code
duration_ms
error_message
created_at
```

当前实现不会保存 `Authorization` 请求头，但会把请求体和响应体截断到 100000 字符后原样保存；
`contentMd`、分享密码等正文敏感字段不会自动脱敏。调用方应避免在非必要字段中传递秘密，并限制
调用日志的访问权限。审计写入失败只记录服务端告警，不会覆盖原始业务响应。

当前外部 Agent API 没有独立的每 Key 限流器，也不会承诺返回 429 或 `Retry-After`。

## 4. MCP 覆盖范围

`POST /api/mcp` 当前实现：

```text
initialize
notifications/initialized
tools/list
tools/call
```

`tools/list` 返回 13 个核心工具，覆盖知识库列表/树、三种检索、正文读取、问答、文章列表、
文件夹创建以及文章创建/更新/删除/移动。MCP 工具处理器把请求委托给对应 REST 端点，因此复用
同一套鉴权、scope、租户隔离和审计。

分享、AI 生成与 Wiki 接口尚未暴露为 MCP 工具，外部客户端应直接调用 REST。完整工具名和客户端
配置见 [客户端接入](./clients.md)。

## 5. Skill 出口

### 单文件 Skill

`GET /api/agent/skill` 总是由服务端动态生成，内容包含当前站点地址、环境变量约定、安全规则和
REST 示例。它适合安装到 Claude Code、Codex 或其它 Agent 的 skills 目录。

### 可选目录 ZIP

`GET /api/agent/skill-pack` 只是目录打包器：

1. 优先读取 `[agent].skills_directory`；
2. 若未配置，再探测若干开发期 `apps/web/skills` 相对路径；
3. 递归打包目录中的文件；
4. 目录缺失或为空时返回 404。

当前仓库及默认 API 镜像不包含 `apps/web/skills`，所以默认部署应使用 MCP 或单文件 Skill。
Docker 部署自定义目录时，还需把目录以只读卷挂载到 API 容器可见路径。

## 6. 代码入口

| 责任 | 代码位置 |
| --- | --- |
| 路由注册 | `apps/api/internal/routes/agent.go` |
| Key 哈希与认证中间件 | `apps/api/internal/auth/apikey.go` |
| 外部处理器骨架与调用审计 | `apps/api/internal/agentapi/agentapi.go` |
| Key 管理与日志查询 | `apps/api/internal/agentapi/apikey.go` |
| Manifest、Capabilities、Skill | `apps/api/internal/agentapi/discover.go` |
| MCP 协议与 13 个工具 | `apps/api/internal/agentapi/mcp.go` |
| 知识库、文章、分享 | `apps/api/internal/agentapi/kbbrowse.go`、`article.go`、`article_list.go`、`share.go` |
| 检索、读取、问答 | `apps/api/internal/agentapi/docs.go`、`retrieval.go` |
| AI 生成与 Wiki | `apps/api/internal/agentapi/aigen.go`、`wiki.go` |
| 前端 API client | `apps/web/src/lib/api-knowledge.ts` |
| 接入页面 | `apps/web/src/features/pages/agent/` |

## 7. 测试重点

至少覆盖：

- API Key 生命周期、哈希存储、撤销和过期；
- scope 拒绝、租户隔离与资源归属；
- Manifest 与 Capabilities 契约；
- MCP 初始化、工具列表、参数校验和 REST 委托；
- Skill 单文件生成及可选目录打包；
- 审计摘要脱敏和 fail-open 行为。
