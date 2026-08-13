# 把 Petrichor 接入你的 Agent：MCP 与 Skill 包集成指南

Petrichor 提供两条把知识库能力接入外部 Agent（Claude Code、Codex、Cursor 等）的路径，
共用同一套 API Key 与调用审计：

| | MCP Server | Skill 包 |
| --- | --- | --- |
| 形态 | 标准 Model Context Protocol 服务器（Streamable HTTP） | 按意图路由的 SKILL.md + 零依赖 CLI |
| 适用客户端 | 原生支持 MCP 的工具（Claude Code / Codex / Cursor / Claude Desktop 等） | 任何能执行 shell 命令的 Agent |
| 安装成本 | 一行配置，无需下载文件 | 下载 ZIP、解压、改包内 `config.json` |
| 参数校验 | 工具入参带 JSON Schema，客户端调用前校验 | 由 CLI 的 argparse 校验 |
| 能力范围 | 检索 / 阅读 / 问答 / 文章写操作 / Wiki / 分享（18 个工具） | 同 MCP，额外覆盖 AI 摘要 / 思维导图 |
| 推荐场景 | 客户端支持 MCP 时的默认选择 | 客户端不支持 MCP，或需要 AI 生成能力 |

两条路径能力保持一致（Skill 是能力超集），可以同时启用。

## 前置准备

1. 部署好 Petrichor（下文以 `https://your-petrichor.example.com` 代替你的站点地址）。
2. 登录后台，在「Agent 集成 → API Key 管理」生成 API Key（形如 `ptc_live_xxx`）。
   明文只展示一次；服务端只存 SHA-256 哈希，可随时撤销。
3. 权限（scope）按需勾选：`doc:read`（检索/阅读）、`qa:read`（问答）、
   `article:write` / `article:delete`（文章写操作）、`wiki:read` / `wiki:write`（Wiki）、
   `share:write`（分享）、`ai:write`（AI 生成，仅 Skill 用到）。

---

## 一、MCP Server 集成

- 端点：`https://your-petrichor.example.com/api/mcp`
- 传输：Streamable HTTP（POST），无状态，无需 Redis
- 鉴权：请求头 `Authorization: Bearer ptc_live_xxx`（包括 `initialize` 在内所有请求都要求鉴权）

### Claude Code

```bash
claude mcp add --transport http petrichor https://your-petrichor.example.com/api/mcp \
  --header "Authorization: Bearer ptc_live_xxx"
```

默认只对当前项目生效；加 `--scope user` 全局可用。安装后在 `/mcp` 面板里能看到
petrichor 已连接，并列出全部工具。

### Codex CLI

`~/.codex/config.toml`（项目级放 `.codex/config.toml`）：

```toml
[mcp_servers.petrichor]
url = "https://your-petrichor.example.com/api/mcp"
http_headers = { Authorization = "Bearer ptc_live_xxx" }
```

### Cursor / Claude Desktop 等 JSON 配置客户端

Cursor 写入 `~/.cursor/mcp.json`（项目级 `.cursor/mcp.json`），其他客户端写入各自的
MCP 配置文件，格式相同：

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

### 验证与排障

- 验证：让 Agent 调用 `list_knowledge_bases`，能列出知识库即接入成功。
- `401`：API Key 缺失 / 无效 / 已撤销 / 已过期，重新生成并检查请求头。
- `403`：Key 缺少对应 scope，重新生成时勾选所需权限。
- 每次工具调用都会写入「调用日志」，User-Agent 以 `petrichor-mcp/<工具名>` 开头，
  后台会以 MCP 徽标区分展示，可查看完整入参/出参排障。
- `ask_documents`、`wiki_ingest` 会调用模型，耗时较长；Vercel Hobby 计划有函数时长上限，
  这两个工具可能超时，其余工具不受影响。

### MCP 工具清单

| 分组 | 工具 | scope |
| --- | --- | --- |
| 检索与阅读 | `list_knowledge_bases` `get_knowledge_base_tree` `search_documents` `view_document` `list_articles` | `doc:read` |
| 文档问答 | `ask_documents` | `qa:read` |
| 文章与文件夹 | `create_folder` `create_article` `update_article` `move_article` | `article:write` |
| 文章删除 | `delete_article` | `article:delete` |
| 知识 Wiki | `list_wiki_pages` `read_wiki_page` `wiki_lint` | `wiki:read` |
| 文件 Wiki 重建 | `wiki_ingest` | `wiki:write` |
| 文章分享 | `share_article` `get_article_share` `revoke_article_share` | `share:write` |

---

## 二、Skill 包集成

Skill 包是一个 ZIP（`GET /api/agent/skill-pack`），解压后是一个符合 Agent Skills
规范的 `petrichor/` 目录：

```text
petrichor/
├── SKILL.md                 # 根入口：按用户意图路由到子文档
├── config.json              # 站点地址与 Agent API Key
├── skills/                  # setup / articles / docs / qa / share / ai / wiki 七个子能力
├── scripts/petrichor        # 零依赖 Python CLI（所有能力的统一入口）
├── scripts/petrichor-api.sh # curl 版回退脚本
├── references/endpoints.md  # 全部 REST 端点字段与示例
└── assets/manifest.json     # 接口清单快照
```

Agent 只加载根 SKILL.md，按需读取子文档，不会撑爆上下文。

### Claude Code

```bash
curl -L "https://your-petrichor.example.com/api/agent/skill-pack" -o petrichor-skill.zip
unzip -o petrichor-skill.zip -d ~/.claude/skills/        # 全局；项目级用 .claude/skills/
$EDITOR ~/.claude/skills/petrichor/config.json           # 填入 apiKey
chmod +x ~/.claude/skills/petrichor/scripts/petrichor
```

对话中提到知识库相关任务（「问问我的知识库」「把这篇总结存到 Petrichor」）时会自动触发。

### Codex CLI

```bash
unzip -o petrichor-skill.zip -d ~/.codex/skills/         # 或项目的 .codex/skills/
$EDITOR ~/.codex/skills/petrichor/config.json            # 填入 apiKey
chmod +x ~/.codex/skills/petrichor/scripts/petrichor
```

旧版本 Codex 不支持 skills 目录时：把包解压到仓库任意位置，在 `AGENTS.md` 中注明
「Petrichor 相关任务请先阅读 `petrichor/SKILL.md`」。配置仍写 `petrichor/config.json`。

### 其他任何能执行 shell 的 Agent

不依赖 Skill 机制，直接用包内 CLI（仅需 Python 3.8+ 标准库）：

```bash
$EDITOR petrichor/config.json                   # 填入 apiKey
chmod +x petrichor/scripts/petrichor
petrichor/scripts/petrichor capabilities        # 自检：返回权限列表即配置成功
petrichor/scripts/petrichor kb list
petrichor/scripts/petrichor doc tree --query "问题" --kb-id 1
```

没有 Python 的环境用 `scripts/petrichor-api.sh`（curl 版，功能等价）。

### 验证与排障

- 自检：`scripts/petrichor capabilities`。`401` 检查 `config.json` 里的 `apiKey`；`403` 说明缺 scope。
- 所有命令支持 `--help`；错误信息会透传服务端的 `msg` 字段。
- 调用同样记录在「调用日志」中。

---

## 三、能力对照表（MCP 工具 ↔ Skill CLI ↔ REST）

| 能力 | MCP 工具 | Skill CLI 命令 | REST 端点 |
| --- | --- | --- | --- |
| 列出知识库 | `list_knowledge_bases` | `kb list` | `POST /api/agent/knowledge-base/list` |
| 知识库目录树 | `get_knowledge_base_tree` | `kb tree` | `POST /api/agent/knowledge-base/tree` |
| 混合搜索文件分片 / Wiki / 文章 | `search_documents` | `doc search` | `POST /api/agent/document/search` |
| 读取文档 / Wiki 页 | `view_document` | `doc view` | `POST /api/agent/document/view` |
| 文档问答 | `ask_documents` | `doc ask` | `POST /api/agent/document/qa` |
| 列出文章 | `list_articles` | `article list` | `POST /api/agent/article/list` |
| 新建文件夹 | `create_folder` | `folder create` | `POST /api/agent/folder/create` |
| 新建文章 | `create_article` | `article create` | `POST /api/agent/article/create` |
| 更新文章 | `update_article` | `article update` | `POST /api/agent/article/update` |
| 移动文章 | `move_article` | `article move` | `POST /api/agent/article/move` |
| 删除文章 | `delete_article` | `article delete` | `POST /api/agent/article/delete` |
| Wiki 页面列表 | `list_wiki_pages` | `wiki page list` | `POST /api/agent/wiki/page/list` |
| 读取 Wiki 页面 | `read_wiki_page` | `wiki page detail` | `POST /api/agent/wiki/page/detail` |
| Wiki 体检 | `wiki_lint` | `wiki lint` | `POST /api/agent/wiki/lint` |
| 从知识库文件重建 Wiki | `wiki_ingest` | `wiki ingest` | `POST /api/agent/wiki/ingest` |
| 创建/更新分享 | `share_article` | `share create` | `POST /api/agent/article/share/create` |
| 查询分享状态 | `get_article_share` | `share info` | `POST /api/agent/article/share/info` |
| 撤销分享 | `revoke_article_share` | `share revoke` | `POST /api/agent/article/share/revoke` |
| AI 摘要 | —（仅 Skill） | `summary generate` | `POST /api/agent/article/summary/generate` |
| 思维导图 | —（仅 Skill） | `mindmap generate` | `POST /api/agent/article/mindmap/generate` |

> `search_documents` 会统一执行文件分片关键词/向量召回与重排；向量或重排模型不可用时仍保留关键词结果。

## 四、安全建议

- 按最小权限原则为不同 Agent 颁发不同 scope 的 Key；只读场景只给 `doc:read` + `qa:read`。
- 不要把完整 API Key 写入代码仓库、日志或对话记录；泄露后立即在后台撤销。
- 删除文章、撤销分享等危险操作，MCP 工具描述与 Skill 文档都要求 Agent 先向你复述并确认。
- 定期在「调用日志」检查是否有异常来源（IP / User-Agent）的调用。
