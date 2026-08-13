# Agent 接入设计说明

> 面向使用者的客户端接入指南（Claude Code / Codex / Cursor 分别怎么装 MCP 与 Skill 包）见
> [agent-clients.md](./agent-clients.md)；本文侧重设计与实现说明。

## 主流平台模式

- GitBook：公开文档自动生成 MCP Server，AI 工具通过站点 URL 后追加
  `/~gitbook/mcp` 读取文档内容。
  参考：https://gitbook.com/docs/publishing-documentation/mcp-servers-for-published-docs
- Mintlify：公开文档生成只读 MCP Server；可信 Agent 使用带认证的 MCP
  编辑文档，并通过分支/PR 合并变更。
  参考：https://www.mintlify.com/docs/ai/model-context-protocol
  和 https://www.mintlify.com/docs/ai/mintlify-mcp
- ReadMe：提供 MCP Server，并额外提供可下载的 `SKILL.md`，让编辑器或 CI
  内的 Agent 按固定流程搜索、读取、更新文档。
  参考：https://docs.readme.com/main/docs/readmes-mcp-server
- Notion：通过 hosted MCP 与 OAuth 连接工作区，能力按连接权限控制，可搜索、
  读取、新建页面等。
  参考：https://developers.notion.com/guides/mcp/overview
- Claude Code / Codex：Skills 是 `SKILL.md` 形式的工作流说明，适合描述
  “何时调用、如何鉴权、如何执行危险操作确认”；真实读写能力仍应落在 API
  或 MCP Server 上。
  参考：https://code.claude.com/docs/en/skills

## 本项目落地

当前实现采用“REST 能力层 + MCP Server + 单 Skill 路由包”：

- REST 能力层：`/api/agent/**`，统一使用 `Authorization: Bearer <apiKey>`。
- 公开 manifest：`/api/agent/manifest`，让 Agent 不依赖猜测即可发现接口地址。
- Skill 兼容层：`/api/agent/skill`，输出单文件 `SKILL.md`（兼容旧入口）。
- Skill 包：`/api/agent/skill-pack`，输出 `petrichor-agent-skills.zip`，内含一个顶层 `petrichor/` Skill，根目录 `SKILL.md` 按用户意图路由到子文档：
  - `config.json`：站点地址与 Agent API Key 配置。
  - `skills/setup.md`：配置、自检、接口发现。
  - `skills/articles.md`：新建文章、更新文章、删除文章、创建文件夹、移动文章。
  - `skills/docs.md`：知识库列表、目录树、文档搜索、文档查看。
  - `skills/qa.md`：文档问答和引用结果使用。
  - `skills/share.md`：文章分享创建/撤销/查询、密码与到期管理。
  - `skills/ai.md`：AI 摘要、思维导图生成。
  - `scripts/petrichor`、`scripts/petrichor-api.sh`、`references/endpoints.md` 全 skill 共用一份，并默认读取 `config.json`。
- MCP Server：`/api/mcp`，无状态 Streamable HTTP，详见下方「MCP Server」一节。
- API Key：平台账号页生成，服务端只存 `sha256` 哈希，明文只返回一次。
- 调用审计：服务端记录每次外部 Agent API 调用的来源 IP、User-Agent、
  入参、出参、状态码和耗时（MCP 工具调用同样入审计日志，User-Agent 以
  `petrichor-mcp/<toolName>` 开头，可与直接 REST 调用区分）。
- 权限粒度：
  - `article:write`：新建文章
  - `article:delete`：删除文章
  - `doc:read`：文档搜索/查看
  - `qa:read`：文档问答

## 当前外部 Agent 能力

- `GET /api/agent/manifest`：公开接口清单。
- `GET /api/agent/capabilities`：当前 Key 的权限、能力和知识库列表。
- `POST /api/agent/knowledge-base/list`：列出知识库。
- `POST /api/agent/knowledge-base/tree`：查看知识库目录树。
- `POST /api/agent/folder/create`：新建文件夹。
- `POST /api/agent/article/create`：新建文章。
- `POST /api/agent/article/update`：更新文章。
- `POST /api/agent/article/delete`：删除文章。
- `POST /api/agent/document/search`：混合搜索文件分片、Wiki 页面与文章；可用时自动加入向量召回和重排。
- `POST /api/agent/document/view`：查看源文章或 Wiki 页面。
- `POST /api/agent/document/qa`：基于文档上下文问答。
- `POST /api/agent/call-log/list`：登录用户查看外部调用日志。

## MCP Server

`POST /api/mcp` 暴露一个无状态 Streamable HTTP MCP Server
（实现在 `apps/api/internal/agent/mcp.go`），是 REST 能力层之上的协议适配层：
18 个 MCP 工具一一委托到对应的 `/api/agent/**` 端点，鉴权、scope 校验、调用
审计日志全部复用 Go API 的现有实现。工具规格（名称、scope、目标端点、入参 schema）
也集中在该 Go 模块中。

- 鉴权：与 REST 层同一套 API Key，请求头 `Authorization: Bearer <ptc_live_...>`；
  未带或无效 Key 一律 401（`initialize` 也不例外）。
- 传输：仅 Streamable HTTP（POST）；未启用 SSE 传输，因此不需要 Redis，
  可部署到普通 Go 服务或容器运行环境。
- 工具覆盖：知识库/目录树浏览、文件分片/Wiki/文章混合检索、文档阅读、文档问答、
  文章与文件夹写操作、文件 Wiki 重建/体检、文章分享管理。

### 客户端接入

Claude Code：

```bash
claude mcp add --transport http petrichor https://your-petrichor.example.com/api/mcp \
  --header "Authorization: Bearer ptc_live_xxx"
```

Codex CLI（`~/.codex/config.toml`）：

```toml
[mcp_servers.petrichor]
url = "https://your-petrichor.example.com/api/mcp"
http_headers = { Authorization = "Bearer ptc_live_xxx" }
```

Cursor / Claude Desktop 等 JSON 配置的客户端：

```json
{
  "mcpServers": {
    "petrichor": {
      "url": "https://your-petrichor.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ptc_live_xxx" }
    }
  }
}
```
