# Agent 接入设计说明

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

当前实现采用“REST 能力层 + 多 Skill 文件夹包”：

- REST 能力层：`/api/agent/**`，统一使用 `Authorization: Bearer <apiKey>`。
- 公开 manifest：`/api/agent/manifest`，让 Agent 不依赖猜测即可发现接口地址。
- Skill 兼容层：`/api/agent/skill`，输出单文件 `SKILL.md`。
- Skill 包：`/api/agent/skill-pack`，输出 `petrichor-agent-skills.zip`，内含多个 Skill：
  - `petrichor-setup`：环境变量、自检、接口发现。
  - `petrichor-articles`：新建文章、更新文章、删除文章、创建文件夹。
  - `petrichor-docs`：知识库列表、目录树、文档搜索、文档查看。
  - `petrichor-qa`：文档问答和引用结果使用。
- API Key：平台账号页生成，服务端只存 `sha256` 哈希，明文只返回一次。
- 调用审计：所有外部 Agent API 调用都要求带
  `X-Petrichor-Agent-Source`，否则调用失败；服务端记录来源 Agent、具体工具、
  来源 IP、User-Agent、入参、出参、状态码和耗时。
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
- `POST /api/agent/document/search`：搜索文档。
- `POST /api/agent/document/view`：查看源文章或 Wiki 页面。
- `POST /api/agent/document/qa`：基于文档上下文问答。
- `POST /api/agent/call-log/list`：登录用户查看外部调用日志。

后续如果需要和 Cursor、Claude Desktop、ChatGPT 等 MCP 客户端深度集成，可以在
当前 REST 能力层前再包一层 Streamable HTTP MCP Server。
