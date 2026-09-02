# 把 Petrichor 接入你的 Agent：MCP、REST 与 Skill

Petrichor 对外提供三种入口，它们共用同一套 Agent API Key、scope 校验和调用审计：

| 形态 | MCP Server | REST API | 单文件 Skill |
| --- | --- | --- | --- |
| 入口 | `POST /api/mcp` | `/api/agent/**` | `GET /api/agent/skill` |
| 能力范围 | 13 个核心文档工具 | 22 个能力端点 | 教 Agent 用 `curl` 调用 REST |
| 适合 | Claude Code、Codex、Cursor 等支持 MCP 的客户端 | 自研客户端和自动化脚本 | 不支持 MCP、但能读取 Skill 并执行 shell 的 Agent |
| 更新方式 | 服务端即时生效 | 服务端即时生效 | 重新下载 `SKILL.md` |

> `/api/agent/skill-pack` 是可选的目录打包端点，不是默认内置能力。详见
> [可选 ZIP Skill 包](#4-可选-zip-skill-包)。

## 1. 前置准备

在 Petrichor 的 **设置 → Agent 接入 → API Key** 页面生成 Key。明文仅展示一次，请立即保存。

常用 scope：

| Scope | 用途 |
| --- | --- |
| `doc:read` | 知识库、目录树、搜索、正文与 Wiki 读取 |
| `qa:read` | 文档问答 |
| `article:write` | 新建文件夹、创建/更新/移动文章 |
| `article:delete` | 删除文章 |
| `share:write` | 查询、创建或撤销文章分享 |
| `ai:write` | 摘要、思维导图、知识图谱生成 |
| `wiki:read` | Wiki 页面读取与体检 |
| `wiki:write` | Wiki 重建 |

权限应按最小集合授予。详细接口契约见 [REST / MCP 集成设计](./integration.md)。

## 2. MCP Server

MCP 地址：

```text
https://你的域名/api/mcp
```

服务端实现 Streamable HTTP 的 `initialize`、`tools/list` 和 `tools/call`，并要求每个请求携带：

```http
Authorization: Bearer ptc_live_xxx
```

### 2.1 Claude Code

```bash
claude mcp add --transport http petrichor https://你的域名/api/mcp \
  --header "Authorization: Bearer ptc_live_xxx"
```

### 2.2 Codex CLI

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.petrichor]
url = "https://你的域名/api/mcp"
http_headers = { Authorization = "Bearer ptc_live_xxx" }
```

### 2.3 Cursor 或其它 JSON 配置客户端

```json
{
  "mcpServers": {
    "petrichor": {
      "url": "https://你的域名/api/mcp",
      "headers": {
        "Authorization": "Bearer ptc_live_xxx"
      }
    }
  }
}
```

接入成功后，`tools/list` 当前返回以下 13 个工具：

```text
list_knowledge_bases
get_knowledge_base_tree
search_documents
search_document_tree
semantic_search_document_tree
view_document
ask_documents
list_articles
create_folder
create_article
update_article
delete_article
move_article
```

分享、AI 生成和 Wiki 写操作当前只在 REST 能力层提供，尚未映射为 MCP 工具。

## 3. 单文件 Skill

`GET /api/agent/skill` 会按当前请求域名生成一个可直接安装的 `SKILL.md`。下载文件本身不需要
API Key；文件中的受保护 REST 调用需要 `PETRICHOR_API_KEY`。

### 3.1 Claude Code

```bash
mkdir -p ~/.claude/skills/petrichor
curl -L "https://你的域名/api/agent/skill" \
  -o ~/.claude/skills/petrichor/SKILL.md

export PETRICHOR_BASE_URL="https://你的域名"
export PETRICHOR_API_KEY="ptc_live_xxx"
```

若只想让单个项目使用，可把文件放到项目的 `.claude/skills/petrichor/SKILL.md`。

### 3.2 Codex CLI

```bash
mkdir -p ~/.codex/skills/petrichor
curl -L "https://你的域名/api/agent/skill" \
  -o ~/.codex/skills/petrichor/SKILL.md

export PETRICHOR_BASE_URL="https://你的域名"
export PETRICHOR_API_KEY="ptc_live_xxx"
```

旧版客户端不识别 skills 目录时，可以把 `SKILL.md` 放进项目，并在 `AGENTS.md` 中要求处理
Petrichor 任务前先阅读该文件。

### 3.3 自检

```bash
curl -sS "$PETRICHOR_BASE_URL/api/agent/capabilities" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY"
```

响应会返回当前 Key 的 scopes、完整能力清单、MCP 信息以及当前用户的知识库列表。

## 4. 可选 ZIP Skill 包

`GET /api/agent/skill-pack` 会递归读取 `[agent].skills_directory` 指向的目录，并按相对路径原样
打包为 `petrichor-agent-skills.zip`。只有目录存在且至少包含一个文件时才返回 ZIP；否则返回 404：

```json
{
  "code": 404,
  "msg": "Skill 资源目录不存在",
  "path": "/api/agent/skill-pack",
  "timestamp": "..."
}
```

当前仓库和默认 API 镜像不内置该目录，因此推荐直接使用 MCP 或上一节的单文件 Skill。部署者如需
发布自定义多文件 Skill，必须让 API 进程可以读取该目录；Docker 部署还需要把目录挂载进容器。

配置示例：

```toml
[agent]
skills_directory = "/data/agent-skills"
```

服务端只负责打包，不约定目录中的 `config.json`、CLI 或子文档结构。

## 5. REST 与 MCP 能力对照

| 能力 | REST 端点 | MCP |
| --- | --- | :---: |
| 列知识库 | `/api/agent/knowledge-base/list` | ✓ |
| 知识库目录树 | `/api/agent/knowledge-base/tree` | ✓ |
| 关键词搜索 | `/api/agent/document/search` | ✓ |
| 章节树推理检索 | `/api/agent/document/tree` | ✓ |
| 章节树语义检索 | `/api/agent/document/semantic-search` | ✓ |
| 读取文章或 Wiki 正文 | `/api/agent/document/view` | ✓ |
| 文档问答 | `/api/agent/document/qa` | ✓ |
| 列文章 | `/api/agent/article/list` | ✓ |
| 新建文件夹 | `/api/agent/folder/create` | ✓ |
| 新建文章 | `/api/agent/article/create` | ✓ |
| 更新文章 | `/api/agent/article/update` | ✓ |
| 删除文章 | `/api/agent/article/delete` | ✓ |
| 移动文章 | `/api/agent/article/move` | ✓ |
| 查询分享状态 | `/api/agent/article/share/info` | — |
| 创建或更新分享 | `/api/agent/article/share/create` | — |
| 撤销分享 | `/api/agent/article/share/revoke` | — |
| AI 摘要 | `/api/agent/article/summary/generate` | — |
| AI 思维导图 / 知识图谱 | `/api/agent/article/mindmap/generate` | — |
| Wiki 页面列表 | `/api/agent/wiki/page/list` | — |
| Wiki 页面详情 | `/api/agent/wiki/page/detail` | — |
| Wiki 体检 | `/api/agent/wiki/lint` | — |
| Wiki 重建 | `/api/agent/wiki/ingest` | — |

## 6. 安全与排障

- API Key 明文只在创建时返回，服务端只保存哈希；
- 通过有效 Key 进入处理器的 `/api/agent/**` 调用都会写入 `petrichor_agent_call_log`；
- `401`：检查 Key 是否正确、已撤销或过期；
- `403`：检查当前 Key 是否包含端点要求的 scope；
- `404`：检查知识库/文章归属；对 `/api/agent/skill-pack` 还要检查资源目录配置；
- 当前外部 Agent API 没有独立的每 Key 限流器，不要依赖 429 或 `Retry-After` 契约；
- 删除文章、撤销分享和模型调用应在客户端先向用户说明影响并取得确认；MCP 的
  `delete_article` 描述也明确要求确认，但 REST 服务端不会替外部客户端弹确认框；
- 不要把 API Key 写入仓库、日志、对话正文或截图；调用日志会保存截断后的请求/响应正文，
  `contentMd`、分享密码等字段当前不会自动脱敏。

下一步：[REST / MCP 集成设计](./integration.md)。
