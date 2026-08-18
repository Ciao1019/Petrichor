export type AgentSkillPackageFile = {
    path: string
    content: string
}

export function normalizeAgentBaseUrl(baseUrl: string) {
    return baseUrl.trim().replace(/\/+$/, "") || "https://your-petrichor.example.com"
}

export function buildAgentEndpointMap() {
    return {
        capabilities: "/api/agent/capabilities",
        manifest: "/api/agent/manifest",
        knowledgeBaseList: "/api/agent/knowledge-base/list",
        knowledgeBaseTree: "/api/agent/knowledge-base/tree",
        folderCreate: "/api/agent/folder/create",
        articleCreate: "/api/agent/article/create",
        articleUpdate: "/api/agent/article/update",
        articleDelete: "/api/agent/article/delete",
        articleList: "/api/agent/article/list",
        articleMove: "/api/agent/article/move",
        articleShareCreate: "/api/agent/article/share/create",
        articleShareRevoke: "/api/agent/article/share/revoke",
        articleShareInfo: "/api/agent/article/share/info",
        articleSummaryGenerate: "/api/agent/article/summary/generate",
        articleMindmapGenerate: "/api/agent/article/mindmap/generate",
        documentSearch: "/api/agent/document/search",
        documentTree: "/api/agent/document/tree",
        documentSemanticSearch: "/api/agent/document/semantic-search",
        documentView: "/api/agent/document/view",
        documentQa: "/api/agent/document/qa",
        wikiPageList: "/api/agent/wiki/page/list",
        wikiPageDetail: "/api/agent/wiki/page/detail",
        wikiLint: "/api/agent/wiki/lint",
        wikiIngest: "/api/agent/wiki/ingest",
        legacySkill: "/api/agent/skill",
        skillPack: "/api/agent/skill-pack",
    }
}

export function buildAgentMcpInfo(baseUrl: string) {
    return {
        endpoint: `${normalizeAgentBaseUrl(baseUrl)}/api/mcp`,
        transport: "streamable-http",
        auth: {
            type: "bearer",
            header: "Authorization: Bearer <apiKey>",
        },
    }
}

export function buildAgentManifest(baseUrl: string) {
    return {
        name: "Petrichor Agent API",
        version: "2026-06-08",
        baseUrl: normalizeAgentBaseUrl(baseUrl),
        mcp: buildAgentMcpInfo(baseUrl),
        auth: {
            type: "bearer",
            env: "PETRICHOR_API_KEY",
            header: "Authorization: Bearer <apiKey>",
        },
        env: {
            PETRICHOR_BASE_URL: normalizeAgentBaseUrl(baseUrl),
            PETRICHOR_API_KEY: "ptc_live_xxx",
        },
        scopes: {
            "article:write": ["article.create", "article.update", "article.move", "folder.create"],
            "article:delete": ["article.delete"],
            "doc:read": ["knowledge-base.list", "knowledge-base.tree", "article.list", "document.search", "document.tree", "document.semantic-search", "document.view"],
            "qa:read": ["document.qa"],
            "share:write": ["article.share.create", "article.share.revoke", "article.share.info"],
            "ai:write": ["article.summary.generate", "article.mindmap.generate"],
            "wiki:read": ["wiki.page.list", "wiki.page.detail", "wiki.lint"],
            "wiki:write": ["wiki.ingest"],
        },
        endpoints: buildAgentEndpointMap(),
    }
}

export function buildAgentSkillMarkdown(baseUrl: string) {
    const normalizedBaseUrl = normalizeAgentBaseUrl(baseUrl)
    const endpoints = buildAgentEndpointMap()

    return `---
name: petrichor
description: Use this skill when an AI agent needs to call the Petrichor external Agent API for knowledge bases, articles, document search, document viewing, document question answering, article sharing, or AI summary / mindmap generation. Triggers include create / update / delete article, browse knowledge base, search docs, ask the knowledge base, share article, summarize article.
---

# Petrichor

兼容旧入口的单文件 Skill。推荐改用完整 Skill 包，里面是一个 \`petrichor/\` 顶层 skill，
内部按用户意图路由到 articles / docs / qa / share / ai / wiki / setup 子文档：

\`\`\`bash
curl -L "${normalizedBaseUrl}${endpoints.skillPack}" -o petrichor-skill.zip
\`\`\`

## 环境变量

\`\`\`bash
export PETRICHOR_BASE_URL="${normalizedBaseUrl}"
export PETRICHOR_API_KEY="ptc_live_xxx"
\`\`\`

## 通用规则

- 推荐用 Skill 包内附带的 \`scripts/petrichor\` CLI（零依赖 Python 3.8+）代替裸 curl，错误信息更友好。
- 不要输出完整 API Key。
- 所有受保护接口带上 \`Authorization: Bearer $PETRICHOR_API_KEY\`。
- 删除文章前必须向用户复述文章 ID 和标题，并获得明确确认。
- 启用分享密码、设置到期时间、撤销分享前，先用 \`share info\` 复述当前状态。
- 触发 AI 生成（summary、mindmap）前，先告诉用户会调用模型可能产生费用。
- 不确定知识库或文章 ID 时，先查 manifest、capabilities、知识库列表和文档搜索。

## 快速命令

\`\`\`bash
curl -sS "$PETRICHOR_BASE_URL${endpoints.manifest}"
curl -sS "$PETRICHOR_BASE_URL${endpoints.capabilities}" \\
  -H "Authorization: Bearer $PETRICHOR_API_KEY"
\`\`\`

文章：

\`\`\`bash
curl -sS -X POST "$PETRICHOR_BASE_URL${endpoints.articleCreate}" \\
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"knowledgeBaseId":"1","title":"标题","contentMd":"# 标题\\n\\n正文","tags":["agent"]}'
\`\`\`

文档问答：

\`\`\`bash
curl -sS -X POST "$PETRICHOR_BASE_URL${endpoints.documentQa}" \\
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"question":"问题","knowledgeBaseId":"1","limit":6}'
\`\`\`
`
}

export function buildAgentSkillPackageFiles(baseUrl: string): AgentSkillPackageFile[] {
    const normalizedBaseUrl = normalizeAgentBaseUrl(baseUrl)
    const manifest = buildAgentManifest(normalizedBaseUrl)

    return [
        { path: "petrichor/SKILL.md", content: buildRootSkillMarkdown(normalizedBaseUrl) },
        { path: "petrichor/config.json", content: buildSkillConfigJson(normalizedBaseUrl) },
        { path: "petrichor/skills/setup.md", content: buildSetupSubSkillMarkdown(normalizedBaseUrl) },
        { path: "petrichor/skills/articles.md", content: buildArticlesSubSkillMarkdown() },
        { path: "petrichor/skills/docs.md", content: buildDocsSubSkillMarkdown() },
        { path: "petrichor/skills/qa.md", content: buildQaSubSkillMarkdown() },
        { path: "petrichor/skills/share.md", content: buildShareSubSkillMarkdown() },
        { path: "petrichor/skills/ai.md", content: buildAiSubSkillMarkdown() },
        { path: "petrichor/skills/wiki.md", content: buildWikiSubSkillMarkdown() },
        { path: "petrichor/scripts/petrichor", content: buildPetrichorPythonCli() },
        { path: "petrichor/scripts/petrichor-api.sh", content: buildApiHelperScript() },
        { path: "petrichor/references/endpoints.md", content: buildCommonEndpointReference() },
        { path: "petrichor/assets/manifest.json", content: JSON.stringify(manifest, null, 2) },
    ]
}

export function buildAgentSkillPackageZip(baseUrl: string) {
    return createZip(buildAgentSkillPackageFiles(baseUrl))
}

function buildSkillConfigJson(baseUrl: string) {
    return `${JSON.stringify({
        baseUrl: normalizeAgentBaseUrl(baseUrl),
        apiKey: "ptc_live_xxx",
    }, null, 2)}
`
}

function buildRootSkillMarkdown(baseUrl: string) {
    return `---
name: petrichor
description: Use this skill when an AI agent needs to call the Petrichor external Agent API. Covers knowledge base browsing, article CRUD, folder organization, full-text document search, tree-based reasoning retrieval, vector semantic search, document viewing, knowledge-base question answering, article share-link management, AI summary / mindmap / knowledge-graph generation, and knowledge Wiki browsing / ingest / lint. Triggers include create / update / delete article, organize folders, browse knowledge base, search docs, semantic search, ask the knowledge base, share article, set share password, summarize article, generate mindmap, generate knowledge graph, browse wiki pages, rebuild wiki, lint wiki.
---

# Petrichor

Petrichor 的外部 Agent 入口。整个 skill 只暴露一个 \`petrichor\`，根据用户意图按需读取对应子文档，不要一次性加载所有子文档。

## 首次配置/排错

\`\`\`bash
chmod +x scripts/petrichor
\`\`\`

编辑同目录的 \`config.json\`，填入 Petrichor 站点地址和 Agent API Key：

\`\`\`json
{
  "baseUrl": "${baseUrl}",
  "apiKey": "ptc_live_xxx"
}
\`\`\`

> \`scripts/petrichor\` 和 \`scripts/petrichor-api.sh\` 都优先读取 \`config.json\`；环境变量仅作为兼容兜底。
> 如果运行环境没有 Python 3.8+，回退到 \`scripts/petrichor-api.sh\`（curl 版本，功能等价）。

## 路由（按用户意图选一个子文档读）

| 用户意图 | 读取这个子文档 |
| --- | --- |
| 配置、自检、查 API Key 权限、发现接口 | \`Read skills/setup.md\` |
| 新建 / 更新 / 删除文章、新建文件夹、移动文章 | \`Read skills/articles.md\` |
| 浏览知识库、看目录树、列文章、搜索文档（关键词 / 推理 / 语义）、查看正文 / Wiki | \`Read skills/docs.md\` |
| 文档问答、跨库问答、引用知识库内容回答 | \`Read skills/qa.md\` |
| 公开文章、设置分享密码 / 到期、撤销分享、查询分享状态 | \`Read skills/share.md\` |
| AI 摘要、思维导图、知识图谱生成 | \`Read skills/ai.md\` |
| 浏览知识 Wiki 页面、重建 / ingest Wiki、Wiki 体检 lint | \`Read skills/wiki.md\` |

子文档默认按需加载；用户的请求涉及多个意图（例如先搜索再问答）时按顺序读多个子文档。

## 通用规则（任何子文档都生效）

- 不要把完整 API Key 写入文件、提交、日志或最终回复。
- 所有受保护接口必须带 \`Authorization: Bearer <apiKey>\`，CLI 会从 \`config.json\` 读取并自动添加，否则会失败并写入审计日志。
- 删除文章前必须向用户复述文章 ID 和标题，并获得明确确认。
- 启用分享密码、设置到期时间、撤销分享前，先用 \`share info\` 复述当前状态。
- 触发 AI 生成（summary、mindmap）前，先告诉用户会调用模型可能产生费用。
- 不确定知识库或文章 ID 时，先查 \`scripts/petrichor capabilities\` 或 \`scripts/petrichor kb list\`，不要靠猜。

## 接口手册

详细字段、curl 示例都在 \`references/endpoints.md\`，按需读取。
`
}

function buildSetupSubSkillMarkdown(baseUrl: string) {
    return `# Petrichor — Setup（配置与自检）

## CLI

Skill 内置了一个零依赖的 Python CLI（仅需 Python 3.8+，使用标准库）。首次使用前赋予执行权限：

\`\`\`bash
chmod +x scripts/petrichor
\`\`\`

> 如果运行环境没有 Python，可以回退到 \`scripts/petrichor-api.sh\`（curl 版本，功能等价）。

## 配置文件

编辑 skill 根目录的 \`config.json\`：

\`\`\`json
{
  "baseUrl": "${baseUrl}",
  "apiKey": "ptc_live_xxx"
}
\`\`\`

\`baseUrl\` 通常已经由下载地址自动写好；把 \`apiKey\` 改成「Agent 集成 → API Key 管理」里生成的明文 Key。
不要把完整 API Key 提交到代码仓库、日志或最终回复。

## 自检

\`\`\`bash
scripts/petrichor capabilities
\`\`\`

如果返回 401，要求用户重新生成或检查 API Key。
如果返回 403，说明当前 Key 权限不足。

## 发现接口

- 公开 manifest：\`scripts/petrichor manifest\`
- 带鉴权能力：\`scripts/petrichor capabilities\`
- 详细接口说明：按需读取 \`references/endpoints.md\`
- 所有命令支持 \`--help\`，例如 \`scripts/petrichor article create --help\`

## MCP Server（可选替代）

如果运行环境是支持 MCP 的客户端（Claude Code、Codex、Cursor 等），也可以不装本 Skill，
直接连接 Petrichor 的 MCP Server（同一套 API Key，能力与本 Skill 的文档/检索/写作能力一致）：

\`\`\`text
端点：<baseUrl>/api/mcp（Streamable HTTP）
鉴权：Authorization: Bearer <apiKey>
\`\`\`
`
}

function buildArticlesSubSkillMarkdown() {
    return `# Petrichor — Articles（文章/文件夹写操作）

## 工作流

1. 不确定知识库 ID 时，先 \`scripts/petrichor capabilities\` 或 \`scripts/petrichor kb list\`。
2. 不确定父目录时，\`scripts/petrichor kb tree --kb-id <ID>\`。
3. 新建文件夹用 \`scripts/petrichor folder create\`。
4. 新建文章用 \`scripts/petrichor article create\`，长正文写入临时文件后用 \`--content-file\`。
5. 更新文章用 \`scripts/petrichor article update\`，必须传完整标题和 Markdown 正文。
6. 删除文章前必须向用户复述文章 ID 和标题，并获得明确确认。

## 命令

新建文章（短正文用 \`--content\`，长正文用 \`--content-file\`）：

\`\`\`bash
scripts/petrichor article create \\
  --kb-id 1 \\
  --title "文章标题" \\
  --content $'# 文章标题\\n\\n正文' \\
  --tag agent --tag draft
\`\`\`

\`\`\`bash
scripts/petrichor article create \\
  --kb-id 1 --parent-id 5 \\
  --title "长文章" \\
  --content-file /tmp/draft.md
\`\`\`

更新文章 / 新建文件夹 / 删除文章：

\`\`\`bash
scripts/petrichor article update --article-id 123 --title "新标题" --content-file /tmp/draft.md --tag updated
scripts/petrichor folder create --kb-id 1 --name "新文件夹"
scripts/petrichor article delete --article-id 123
\`\`\`

移动文章到另一个文件夹（追加到末尾）：

\`\`\`bash
scripts/petrichor article move --article-id 123 --parent-id 5
scripts/petrichor article move --article-id 123 --parent-root
\`\`\`

\`references/endpoints.md\` 内有等价 curl 示例与完整字段说明。
`
}

function buildDocsSubSkillMarkdown() {
    return `# Petrichor — Docs（文档读 / 搜 / 看）

## 工作流

1. 先 \`scripts/petrichor kb list\` 找知识库。
2. 需要目录结构时 \`scripts/petrichor kb tree --kb-id <ID>\`。
3. 平铺列出某知识库的文章用 \`scripts/petrichor article list --kb-id <ID>\`，可加 \`--tag\` / \`--keyword\` / \`--parent-id\` / \`--direct\` 过滤。
4. 搜索内容 \`scripts/petrichor doc search\`；跨库搜索时省略 \`--kb-id\`。
5. 细节性问题优先用目录树推理检索 \`scripts/petrichor doc tree --query "问题" --kb-id <ID>\`，比关键词更精准；只想在某篇文档内检索时加 \`--article-id\`。
6. 用户使用近义/概念性表述、或 \`doc tree\` 召回不佳时，改用向量语义检索 \`scripts/petrichor doc semantic --query "问题" --kb-id <ID>\`（需服务端配置 PostgreSQL + 向量模型，不可用时会返回错误，回退到 \`doc tree\`）。
7. 读取原文 \`scripts/petrichor doc view --article-id <ID>\`。
8. 读取 Wiki 页面 \`scripts/petrichor doc view --kb-id <ID> --page-key <key>\`。

## 命令

\`\`\`bash
scripts/petrichor article list --kb-id 1 --tag draft --keyword 周报 --limit 20
scripts/petrichor article list --kb-id 1 --parent-id 5 --direct
scripts/petrichor doc search --query "关键词" --kb-id 1 --limit 8
scripts/petrichor doc tree --query "问题" --kb-id 1 --limit 6
scripts/petrichor doc tree --query "问题" --kb-id 1 --article-id 123
scripts/petrichor doc semantic --query "概念性问题" --kb-id 1 --limit 6
scripts/petrichor doc view --article-id 123
scripts/petrichor doc view --kb-id 1 --page-key index
\`\`\`

详细字段见 \`references/endpoints.md\`。
`
}

function buildQaSubSkillMarkdown() {
    return `# Petrichor — QA（文档问答）

## 工作流

1. 如果用户限定知识库，传 \`--kb-id\`。
2. 如果用户没有限定知识库，省略 \`--kb-id\`，使用跨库问答。
3. 回答时优先使用接口返回的 \`answer\` 和 \`citations\`。
4. 如果返回"未找到足够依据"，不要编造；改用 docs 子能力（\`Read skills/docs.md\`）搜索更多上下文。

## 命令

\`\`\`bash
scripts/petrichor doc ask --question "这里写问题" --kb-id 1 --limit 6
scripts/petrichor doc ask --question "跨库的问题"
\`\`\`

详细字段见 \`references/endpoints.md\`。
`
}

function buildShareSubSkillMarkdown() {
    return `# Petrichor — Share（文章分享管理）

需要 \`share:write\` 权限。所有操作面向单篇文章，仅文章拥有者可执行。

## 工作流

1. 公开分享一篇文章：\`scripts/petrichor share create --article-id <ID>\`。
2. 设置访问密码（6 位数字）：加 \`--password 123456\`。
3. 关闭访问密码（保留分享链接）：加 \`--password-disable\`。
4. 设置/更新到期时间：加 \`--expires-at 2026-12-31T23:59:59Z\`（ISO 8601）。
5. 撤销分享：\`scripts/petrichor share revoke --article-id <ID>\`。
6. 查询分享状态：\`scripts/petrichor share info --article-id <ID>\`。
7. 启用/修改密码或到期时间前，先用 \`share info\` 复述当前状态再操作。

## 示例

\`\`\`bash
scripts/petrichor share create --article-id 123 \\
  --password 123456 --expires-at 2026-12-31T23:59:59Z

scripts/petrichor share create --article-id 123 --password-disable

scripts/petrichor share revoke --article-id 123
scripts/petrichor share info --article-id 123
\`\`\`

返回中的 \`shareUrl\` 是相对路径，对外完整链接需要拼接 \`config.json\` 里的 \`baseUrl\`。
`
}

function buildAiSubSkillMarkdown() {
    return `# Petrichor — AI（摘要 / 思维导图 / 知识图谱）

需要 \`ai:write\` 权限。生成操作会调用用户配置的默认对话模型，可能产生费用。

## 工作流

1. 生成摘要：\`scripts/petrichor summary generate --article-id <ID>\`。命中缓存直接返回。
2. 强制重生成摘要：加 \`--force\`，无论缓存是否命中都重算。
3. 生成思维导图：\`scripts/petrichor mindmap generate --article-id <ID>\`。
4. 生成知识图谱：加 \`--mode KNOWLEDGE_GRAPH\`。
5. 用户没要求重算时优先依赖缓存，避免无意义的模型调用。

## 示例

\`\`\`bash
scripts/petrichor summary generate --article-id 123
scripts/petrichor summary generate --article-id 123 --force

scripts/petrichor mindmap generate --article-id 123
scripts/petrichor mindmap generate --article-id 123 --mode KNOWLEDGE_GRAPH --force
\`\`\`

返回包含 \`fromCache\`、\`generatedAt\` 和数据本身；如果是缓存命中，可以直接复用前一次结果。
`
}

function buildWikiSubSkillMarkdown() {
    return `# Petrichor — Wiki（知识 Wiki 浏览 / ingest / 体检）

知识 Wiki 是在某个知识库的文章之上自动生成、互相链接的结构化页面（index / concept / entity / comparison / answer / source 等）。
读操作需要 \`wiki:read\`；触发 ingest 重建需要 \`wiki:write\`。所有操作面向单个知识库，仅知识库拥有者可执行。

## 工作流

1. 不确定知识库 ID 时，先 \`scripts/petrichor kb list\`。
2. 浏览 Wiki 页面清单：\`scripts/petrichor wiki page list --kb-id <ID>\`，拿到每页的 \`pageKey\`。
3. 读取单页正文与出处：\`scripts/petrichor wiki page detail --kb-id <ID> --page-key <key>\`。
4. 体检 Wiki（断链、缺页、待审批补丁等）：\`scripts/petrichor wiki lint --kb-id <ID>\`，先看问题再决定要不要重建。
5. 重建 / 增量 ingest：\`scripts/petrichor wiki ingest --kb-id <ID>\`。
   - 只想针对部分文章重建时加 \`--article-id\`（可重复）。
   - 想忽略缓存整体重建时加 \`--force\`。
   - 想彻底重来时加 \`--full\`：先清空该知识库现有 Wiki（含问答沉淀的概念/答案页）再从零编译，
     属于破坏性操作，必须先向用户确认，且不能与 \`--article-id\` 同时使用。
6. ingest 会调用模型、可能产生费用，触发前先告诉用户。

> 读取单篇 Wiki 页面正文也可以走 docs 子能力：\`scripts/petrichor doc view --kb-id <ID> --page-key <key>\`。
> 知识图谱生成不在这里，走 AI 子能力：\`scripts/petrichor mindmap generate --article-id <ID> --mode KNOWLEDGE_GRAPH\`（\`Read skills/ai.md\`）。

## 命令

\`\`\`bash
scripts/petrichor wiki page list --kb-id 1
scripts/petrichor wiki page detail --kb-id 1 --page-key index
scripts/petrichor wiki lint --kb-id 1

scripts/petrichor wiki ingest --kb-id 1
scripts/petrichor wiki ingest --kb-id 1 --article-id 12 --article-id 34
scripts/petrichor wiki ingest --kb-id 1 --force
scripts/petrichor wiki ingest --kb-id 1 --full
\`\`\`

详细字段见 \`references/endpoints.md\`。
`
}

function buildApiHelperScript() {
    return `#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
skill_root="$(cd "$script_dir/.." && pwd)"
config_file="$skill_root/config.json"

method="\${1:-}"
path="\${2:-}"
body="\${3:-}"

read_config_field() {
  local field="$1"
  if [[ ! -f "$config_file" ]]; then
    return 0
  fi
  awk -F '"' -v field="$field" '$2 == field { print $4; exit }' "$config_file"
}

base_url="$(read_config_field baseUrl)"
api_key="$(read_config_field apiKey)"
if [[ -z "$base_url" || "$base_url" == "https://your-petrichor.example.com" ]]; then
  base_url="\${PETRICHOR_BASE_URL:-$base_url}"
fi
if [[ -z "$api_key" || "$api_key" == "ptc_live_xxx" ]]; then
  api_key="\${PETRICHOR_API_KEY:-$api_key}"
fi

if [[ -z "$base_url" || "$base_url" == "https://your-petrichor.example.com" ]]; then
  echo "缺少 baseUrl：请编辑 $config_file" >&2
  exit 2
fi

if [[ -z "$api_key" || "$api_key" == "ptc_live_xxx" ]]; then
  echo "缺少 apiKey：请编辑 $config_file" >&2
  exit 2
fi

if [[ -z "$method" || -z "$path" ]]; then
  echo "用法: bash scripts/petrichor-api.sh METHOD /api/agent/path JSON_BODY" >&2
  exit 2
fi

base="\${base_url%/}"
url="$base$path"

if [[ -n "$body" ]]; then
  curl -sS -X "$method" "$url" \\
    -H "Authorization: Bearer $api_key" \\
    -H "Content-Type: application/json" \\
    -d "$body"
else
  curl -sS -X "$method" "$url" \\
    -H "Authorization: Bearer $api_key" \\
    -H "Content-Type: application/json"
fi
`
}

function buildCommonEndpointReference() {
    return `# Petrichor Agent API Endpoints

## 鉴权

所有受保护接口使用：

\`\`\`http
Authorization: Bearer <apiKey>
\`\`\`

## 发现与自检

- \`GET /api/agent/manifest\`：公开接口清单，不需要 API Key。
- \`GET /api/agent/capabilities\`：当前 Key 的权限、可用能力和知识库列表。

## 知识库

- \`POST /api/agent/knowledge-base/list\`
  - body: \`{}\`
- \`POST /api/agent/knowledge-base/tree\`
  - body: \`{"knowledgeBaseId":"1"}\`

## 文件夹

- \`POST /api/agent/folder/create\`
  - scope: \`article:write\`
  - body: \`{"knowledgeBaseId":"1","parentId":null,"name":"文件夹"}\`

## 文章

- \`POST /api/agent/article/create\`
  - scope: \`article:write\`
  - body: \`{"knowledgeBaseId":"1","parentId":null,"title":"标题","contentMd":"# 标题","tags":[]}\`
- \`POST /api/agent/article/update\`
  - scope: \`article:write\`
  - body: \`{"articleId":"123","title":"标题","contentMd":"# 标题","tags":[]}\`
- \`POST /api/agent/article/delete\`
  - scope: \`article:delete\`
  - body: \`{"articleId":"123"}\`
- \`POST /api/agent/article/list\`
  - scope: \`doc:read\`
  - body: \`{"knowledgeBaseId":"1","parentId":null,"parentScope":"ANY","tags":[],"keyword":"","limit":50}\`
  - \`parentScope\`：\`ANY\`（默认，包含子孙节点）或 \`DIRECT\`（仅直接子节点）。
  - 省略 \`parentId\` 时不过滤父节点；显式传 \`null\` 表示根目录。
- \`POST /api/agent/article/move\`
  - scope: \`article:write\`
  - body: \`{"articleId":"123","parentId":"5","targetIndex":0}\`
  - \`parentId\` 为 \`null\` 表示移动到根目录；省略 \`targetIndex\` 默认追加到末尾。

## 分享

- \`POST /api/agent/article/share/create\`
  - scope: \`share:write\`
  - body: \`{"articleId":"123","accessPassword":"123456","passwordEnabled":true,"expiresAt":"2026-12-31T23:59:59Z"}\`
  - 不带 \`passwordEnabled\` 时保持原有密码设置；\`passwordEnabled\` 为 \`false\` 会移除密码。
  - \`expiresAt\` 接受 ISO 8601 字符串；省略则不设置/沿用原值（首次创建时为永不过期）。
- \`POST /api/agent/article/share/revoke\`
  - scope: \`share:write\`
  - body: \`{"articleId":"123"}\`
- \`POST /api/agent/article/share/info\`
  - scope: \`share:write\`
  - body: \`{"articleId":"123"}\`

## AI 生成

- \`POST /api/agent/article/summary/generate\`
  - scope: \`ai:write\`
  - body: \`{"articleId":"123","forceRebuild":false}\`
  - 命中缓存时 \`fromCache: true\`，不会再次调用模型。
- \`POST /api/agent/article/mindmap/generate\`
  - scope: \`ai:write\`
  - body: \`{"articleId":"123","mode":"MINDMAP","forceRebuild":false}\`
  - \`mode\`：\`MINDMAP\`（思维导图，默认）或 \`KNOWLEDGE_GRAPH\`（知识图谱）。

## 文档

- \`POST /api/agent/document/search\`
  - scope: \`doc:read\`
  - body: \`{"query":"关键词","knowledgeBaseId":"1","limit":8}\`
  - 跨库搜索时省略 \`knowledgeBaseId\`。
- \`POST /api/agent/document/tree\`
  - scope: \`doc:read\`
  - body: \`{"query":"问题","knowledgeBaseId":"1","limit":6,"articleId":"123"}\`
  - PageIndex 式推理检索：在文档目录树上按问题推理导航，返回最相关的章节节点（含面包屑 \`path\`、\`summary\`、\`contentMd\` 片段、\`nodeKey\` 与 \`articleId\`）。
  - \`knowledgeBaseId\` 必填；只想在某篇文档内检索时加 \`articleId\`。比关键词搜索更精准，适合细节性问题。
- \`POST /api/agent/document/semantic-search\`
  - scope: \`doc:read\`
  - body: \`{"query":"问题","knowledgeBaseId":"1","limit":6,"articleId":"123"}\`
  - 向量语义检索：对目录树章节节点做向量相似度召回，返回结构与 \`document/tree\` 一致。
  - 适合近义/概念性表述；需服务端配置 PostgreSQL 与向量模型，否则返回 400。
- \`POST /api/agent/document/view\`
  - scope: \`doc:read\`
  - 读取文章：\`{"articleId":"123"}\`
  - 读取 Wiki：\`{"knowledgeBaseId":"1","pageKey":"index"}\`

## 问答

- \`POST /api/agent/document/qa\`
  - scope: \`qa:read\`
  - body: \`{"question":"问题","knowledgeBaseId":"1","limit":6}\`
  - 跨库问答时省略 \`knowledgeBaseId\`。

## 知识 Wiki

- \`POST /api/agent/wiki/page/list\`
  - scope: \`wiki:read\`
  - body: \`{"knowledgeBaseId":"1"}\`
  - 返回该知识库的全部 Wiki 页面（含 \`pageKey\`、\`kind\`、\`title\` 等）。
- \`POST /api/agent/wiki/page/detail\`
  - scope: \`wiki:read\`
  - body: \`{"knowledgeBaseId":"1","pageKey":"index"}\`
  - 返回单页正文、出处引用和关联链接。
- \`POST /api/agent/wiki/lint\`
  - scope: \`wiki:read\`
  - body: \`{"knowledgeBaseId":"1"}\`
  - 返回 Wiki 体检结果（断链、缺页、待审批补丁等）。
- \`POST /api/agent/wiki/ingest\`
  - scope: \`wiki:write\`
  - body: \`{"knowledgeBaseId":"1","articleIds":["12","34"],"forceRebuild":false,"fullRebuild":false}\`
  - 省略 \`articleIds\` 时对整个知识库做增量 ingest；\`forceRebuild\` 为 \`true\` 时忽略缓存整体重建。
  - \`fullRebuild\` 为 \`true\` 时先清空该知识库全部 Wiki 页面、链接与目录树再从零编译，
    返回体里的 \`purged\` 会给出清空数量；该参数不能与 \`articleIds\` 同时传。
  - 会调用模型，可能产生费用。
`
}

function buildPetrichorPythonCli() {
    return `#!/usr/bin/env python3
"""
Petrichor Agent CLI — zero-dep wrapper around the Petrichor external Agent API.

Requires Python 3.8+. Uses only the standard library (urllib, argparse, json).

Configuration:
  Edit ../config.json next to this script:
    {"baseUrl": "https://petrichor.example.com", "apiKey": "ptc_live_xxx"}

Environment variables PETRICHOR_BASE_URL and PETRICHOR_API_KEY are only fallback
compatibility inputs.

Run --help on any command to see usage:
  petrichor --help
  petrichor article create --help
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional
from urllib import error as urlerror
from urllib import request as urlrequest

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CONFIG = 3
EXIT_HTTP = 4
EXIT_NETWORK = 5

CONFIG_PLACEHOLDER_BASE_URL = "https://your-petrichor.example.com"
CONFIG_PLACEHOLDER_API_KEY = "ptc_live_xxx"
_CONFIG_CACHE: Optional[Dict[str, Any]] = None


def _config_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config.json"))


def _load_config() -> Dict[str, Any]:
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE
    path = _config_path()
    if not os.path.exists(path):
        _CONFIG_CACHE = {}
        return _CONFIG_CACHE
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"[petrichor] Cannot read config {path}: {e}\\n")
        sys.exit(EXIT_CONFIG)
    if not isinstance(raw, dict):
        sys.stderr.write(f"[petrichor] Config {path} must be a JSON object\\n")
        sys.exit(EXIT_CONFIG)
    _CONFIG_CACHE = raw
    return _CONFIG_CACHE


def _setting(config_key: str, env_name: str, placeholder: str, required: bool = True) -> Optional[str]:
    raw = _load_config().get(config_key)
    value = str(raw).strip() if raw is not None else ""
    if value and value != placeholder:
        return value
    env_value = os.environ.get(env_name, "").strip()
    if env_value:
        return env_value
    if required:
        sys.stderr.write(f"[petrichor] Missing {config_key}; edit {_config_path()}\\n")
        sys.exit(EXIT_CONFIG)
    return None


def _request(
    method: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    require_auth: bool = True,
) -> Dict[str, Any]:
    base_url = _setting("baseUrl", "PETRICHOR_BASE_URL", CONFIG_PLACEHOLDER_BASE_URL).rstrip("/")
    url = base_url + path
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if require_auth:
        headers["Authorization"] = f"Bearer {_setting('apiKey', 'PETRICHOR_API_KEY', CONFIG_PLACEHOLDER_API_KEY)}"

    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urlrequest.Request(url, data=data, method=method, headers=headers)
    try:
        with urlrequest.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except urlerror.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        msg = _extract_error_message(raw) or f"HTTP {e.code} {e.reason}"
        sys.stderr.write(f"[petrichor] {method} {path} failed: {msg}\\n")
        sys.exit(EXIT_HTTP)
    except urlerror.URLError as e:
        sys.stderr.write(f"[petrichor] Network error: {e.reason}\\n")
        sys.exit(EXIT_NETWORK)

    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write(f"[petrichor] Non-JSON response from {path}: {text[:500]}\\n")
        sys.exit(EXIT_HTTP)


def _extract_error_message(raw: str) -> Optional[str]:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:500]
    if isinstance(data, dict):
        for key in ("msg", "message", "error"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return json.dumps(data, ensure_ascii=False)
    return raw[:500]


def _read_content(args: argparse.Namespace) -> str:
    content = getattr(args, "content", None)
    content_file = getattr(args, "content_file", None)
    if content and content_file:
        sys.stderr.write("[petrichor] --content and --content-file are mutually exclusive\\n")
        sys.exit(EXIT_USAGE)
    if content_file:
        try:
            with open(content_file, "r", encoding="utf-8") as f:
                return f.read()
        except OSError as e:
            sys.stderr.write(f"[petrichor] Cannot read {content_file}: {e}\\n")
            sys.exit(EXIT_USAGE)
    if content is None:
        sys.stderr.write("[petrichor] Provide --content or --content-file\\n")
        sys.exit(EXIT_USAGE)
    return content


def _print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _id(value: int) -> str:
    return str(value)


def _optional_id(value: Optional[int]) -> Optional[str]:
    return None if value is None else str(value)


# ---- command handlers --------------------------------------------------------

def cmd_capabilities(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/capabilities", {}))


def cmd_manifest(args: argparse.Namespace) -> None:
    _print_json(_request("GET", "/api/agent/manifest", None, require_auth=False))


def cmd_kb_list(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/knowledge-base/list", {}))


def cmd_kb_tree(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/knowledge-base/tree", {"knowledgeBaseId": _id(args.kb_id)}))


def cmd_folder_create(args: argparse.Namespace) -> None:
    body = {
        "knowledgeBaseId": _id(args.kb_id),
        "name": args.name,
        "parentId": _optional_id(args.parent_id),
    }
    _print_json(_request("POST", "/api/agent/folder/create", body))


def cmd_article_create(args: argparse.Namespace) -> None:
    body = {
        "knowledgeBaseId": _id(args.kb_id),
        "parentId": _optional_id(args.parent_id),
        "title": args.title,
        "contentMd": _read_content(args),
        "tags": args.tag or [],
    }
    _print_json(_request("POST", "/api/agent/article/create", body))


def cmd_article_update(args: argparse.Namespace) -> None:
    body = {
        "articleId": _id(args.article_id),
        "title": args.title,
        "contentMd": _read_content(args),
        "tags": args.tag or [],
    }
    _print_json(_request("POST", "/api/agent/article/update", body))


def cmd_article_delete(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/article/delete", {"articleId": _id(args.article_id)}))


def cmd_article_list(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {
        "knowledgeBaseId": _id(args.kb_id),
        "parentScope": "DIRECT" if args.direct else "ANY",
        "tags": args.tag or [],
        "keyword": args.keyword or "",
        "limit": args.limit,
    }
    if args.parent_root and args.parent_id is not None:
        sys.stderr.write("[petrichor] --parent-root and --parent-id are mutually exclusive\\n")
        sys.exit(EXIT_USAGE)
    if args.parent_root:
        body["parentId"] = None
    elif args.parent_id is not None:
        body["parentId"] = _id(args.parent_id)
    _print_json(_request("POST", "/api/agent/article/list", body))


def cmd_article_move(args: argparse.Namespace) -> None:
    if args.parent_root and args.parent_id is not None:
        sys.stderr.write("[petrichor] --parent-root and --parent-id are mutually exclusive\\n")
        sys.exit(EXIT_USAGE)
    if not args.parent_root and args.parent_id is None:
        sys.stderr.write("[petrichor] Provide --parent-id or --parent-root\\n")
        sys.exit(EXIT_USAGE)
    body: Dict[str, Any] = {
        "articleId": _id(args.article_id),
        "parentId": None if args.parent_root else _id(args.parent_id),
    }
    if args.target_index is not None:
        body["targetIndex"] = args.target_index
    _print_json(_request("POST", "/api/agent/article/move", body))


def cmd_doc_view(args: argparse.Namespace) -> None:
    if args.article_id is not None:
        body: Dict[str, Any] = {"articleId": _id(args.article_id)}
    elif args.kb_id is not None and args.page_key:
        body = {"knowledgeBaseId": _id(args.kb_id), "pageKey": args.page_key}
    else:
        sys.stderr.write("[petrichor] Provide --article-id, or both --kb-id and --page-key\\n")
        sys.exit(EXIT_USAGE)
    _print_json(_request("POST", "/api/agent/document/view", body))


def cmd_doc_search(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {"query": args.query, "limit": args.limit}
    if args.kb_id is not None:
        body["knowledgeBaseId"] = _id(args.kb_id)
    _print_json(_request("POST", "/api/agent/document/search", body))


def cmd_doc_tree(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {
        "knowledgeBaseId": _id(args.kb_id),
        "query": args.query,
        "limit": args.limit,
    }
    if args.article_id is not None:
        body["articleId"] = _id(args.article_id)
    _print_json(_request("POST", "/api/agent/document/tree", body))


def cmd_doc_semantic(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {
        "knowledgeBaseId": _id(args.kb_id),
        "query": args.query,
        "limit": args.limit,
    }
    if args.article_id is not None:
        body["articleId"] = _id(args.article_id)
    _print_json(_request("POST", "/api/agent/document/semantic-search", body))


def cmd_doc_ask(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {"question": args.question, "limit": args.limit}
    if args.kb_id is not None:
        body["knowledgeBaseId"] = _id(args.kb_id)
    _print_json(_request("POST", "/api/agent/document/qa", body))


def cmd_share_create(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {"articleId": _id(args.article_id)}
    if args.password is not None:
        body["accessPassword"] = args.password
        body["passwordEnabled"] = True
    if args.password_disable:
        body["passwordEnabled"] = False
    if args.expires_at is not None:
        body["expiresAt"] = args.expires_at
    _print_json(_request("POST", "/api/agent/article/share/create", body))


def cmd_share_revoke(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/article/share/revoke", {"articleId": _id(args.article_id)}))


def cmd_share_info(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/article/share/info", {"articleId": _id(args.article_id)}))


def cmd_summary_generate(args: argparse.Namespace) -> None:
    body = {"articleId": _id(args.article_id), "forceRebuild": bool(args.force)}
    _print_json(_request("POST", "/api/agent/article/summary/generate", body))


def cmd_mindmap_generate(args: argparse.Namespace) -> None:
    body = {
        "articleId": _id(args.article_id),
        "mode": args.mode,
        "forceRebuild": bool(args.force),
    }
    _print_json(_request("POST", "/api/agent/article/mindmap/generate", body))


def cmd_wiki_page_list(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/wiki/page/list", {"knowledgeBaseId": _id(args.kb_id)}))


def cmd_wiki_page_detail(args: argparse.Namespace) -> None:
    body = {"knowledgeBaseId": _id(args.kb_id), "pageKey": args.page_key}
    _print_json(_request("POST", "/api/agent/wiki/page/detail", body))


def cmd_wiki_lint(args: argparse.Namespace) -> None:
    _print_json(_request("POST", "/api/agent/wiki/lint", {"knowledgeBaseId": _id(args.kb_id)}))


def cmd_wiki_ingest(args: argparse.Namespace) -> None:
    body: Dict[str, Any] = {
        "knowledgeBaseId": _id(args.kb_id),
        "forceRebuild": bool(args.force),
        "fullRebuild": bool(args.full),
    }
    if args.article_id:
        body["articleIds"] = [_id(value) for value in args.article_id]
    _print_json(_request("POST", "/api/agent/wiki/ingest", body))


# ---- argparse wiring ---------------------------------------------------------

def _add_content_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--content", help="Markdown 正文（与 --content-file 二选一）")
    p.add_argument("--content-file", help="从文件读取 Markdown 正文")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="petrichor", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("capabilities", help="查看当前 API Key 的权限和能力")
    sub.add_parser("manifest", help="查看公开的 Agent API manifest（无需 API Key）")

    kb = sub.add_parser("kb", help="知识库相关")
    kb_sub = kb.add_subparsers(dest="kb_cmd", required=True)
    kb_sub.add_parser("list", help="列出当前用户的全部知识库")
    p = kb_sub.add_parser("tree", help="查看知识库目录树")
    p.add_argument("--kb-id", type=int, required=True)

    folder = sub.add_parser("folder", help="文件夹")
    folder_sub = folder.add_subparsers(dest="folder_cmd", required=True)
    p = folder_sub.add_parser("create", help="新建文件夹")
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--parent-id", type=int, default=None)

    article = sub.add_parser("article", help="文章")
    article_sub = article.add_subparsers(dest="article_cmd", required=True)
    p = article_sub.add_parser("create", help="新建文章")
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--parent-id", type=int, default=None)
    p.add_argument("--title", required=True)
    p.add_argument("--tag", action="append", help="可重复，例：--tag agent --tag draft")
    _add_content_args(p)
    p = article_sub.add_parser("update", help="更新文章（必须传完整标题和正文）")
    p.add_argument("--article-id", type=int, required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--tag", action="append")
    _add_content_args(p)
    p = article_sub.add_parser("delete", help="删除文章")
    p.add_argument("--article-id", type=int, required=True)
    p = article_sub.add_parser("list", help="列出某知识库下的文章，支持 tag / 父节点 / 关键字过滤")
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--parent-id", type=int, default=None, help="只看该父节点下的文章；与 --parent-root 互斥")
    p.add_argument("--parent-root", action="store_true", help="只看根目录下的文章")
    p.add_argument("--direct", action="store_true", help="仅直接子节点；默认包含所有子孙节点")
    p.add_argument("--tag", action="append", help="可重复，命中的文章需同时包含全部 tag")
    p.add_argument("--keyword", default="", help="按标题 ILIKE 模糊匹配")
    p.add_argument("--limit", type=int, default=50)
    p = article_sub.add_parser("move", help="移动文章到另一个文件夹")
    p.add_argument("--article-id", type=int, required=True)
    p.add_argument("--parent-id", type=int, default=None, help="目标父文件夹 ID；与 --parent-root 互斥")
    p.add_argument("--parent-root", action="store_true", help="移动到根目录")
    p.add_argument("--target-index", type=int, default=None, help="目标排序位置，默认追加到末尾")

    doc = sub.add_parser("doc", help="文档查看 / 搜索 / 问答")
    doc_sub = doc.add_subparsers(dest="doc_cmd", required=True)
    p = doc_sub.add_parser("view", help="查看文章正文或 Wiki 页面")
    p.add_argument("--article-id", type=int, default=None)
    p.add_argument("--kb-id", type=int, default=None)
    p.add_argument("--page-key", default=None)
    p = doc_sub.add_parser("search", help="搜索文档")
    p.add_argument("--query", required=True)
    p.add_argument("--kb-id", type=int, default=None)
    p.add_argument("--limit", type=int, default=8)
    p = doc_sub.add_parser("tree", help="目录树推理检索（PageIndex 式，比关键词更精准）")
    p.add_argument("--query", required=True)
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--article-id", type=int, default=None, help="只在某篇文档内检索；省略则检索整个知识库")
    p.add_argument("--limit", type=int, default=6)
    p = doc_sub.add_parser("semantic", help="向量语义检索（近义/概念性表述；需服务端配置 PostgreSQL + 向量模型）")
    p.add_argument("--query", required=True)
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--article-id", type=int, default=None, help="只在某篇文档内检索；省略则检索整个知识库")
    p.add_argument("--limit", type=int, default=6)
    p = doc_sub.add_parser("ask", help="文档问答")
    p.add_argument("--question", required=True)
    p.add_argument("--kb-id", type=int, default=None)
    p.add_argument("--limit", type=int, default=6)

    share = sub.add_parser("share", help="文章分享管理")
    share_sub = share.add_subparsers(dest="share_cmd", required=True)
    p = share_sub.add_parser("create", help="开启/更新分享，可同时设置密码与到期时间")
    p.add_argument("--article-id", type=int, required=True)
    p.add_argument("--password", help="6 位数字访问密码；指定后自动启用密码")
    p.add_argument("--password-disable", action="store_true", help="关闭访问密码（保留分享链接）")
    p.add_argument("--expires-at", help="ISO 8601 时间，例：2026-12-31T23:59:59Z")
    p = share_sub.add_parser("revoke", help="撤销分享")
    p.add_argument("--article-id", type=int, required=True)
    p = share_sub.add_parser("info", help="查看分享状态")
    p.add_argument("--article-id", type=int, required=True)

    summary = sub.add_parser("summary", help="AI 文章摘要")
    summary_sub = summary.add_subparsers(dest="summary_cmd", required=True)
    p = summary_sub.add_parser("generate", help="生成/读取缓存的 AI 摘要")
    p.add_argument("--article-id", type=int, required=True)
    p.add_argument("--force", action="store_true", help="无视缓存强制重新生成")

    mindmap = sub.add_parser("mindmap", help="AI 思维导图 / 知识图谱")
    mindmap_sub = mindmap.add_subparsers(dest="mindmap_cmd", required=True)
    p = mindmap_sub.add_parser("generate", help="生成/读取缓存的思维导图或知识图谱")
    p.add_argument("--article-id", type=int, required=True)
    p.add_argument("--mode", choices=["MINDMAP", "KNOWLEDGE_GRAPH"], default="MINDMAP")
    p.add_argument("--force", action="store_true")

    wiki = sub.add_parser("wiki", help="知识 Wiki 浏览 / ingest / 体检")
    wiki_sub = wiki.add_subparsers(dest="wiki_cmd", required=True)
    page = wiki_sub.add_parser("page", help="Wiki 页面")
    page_sub = page.add_subparsers(dest="wiki_page_cmd", required=True)
    p = page_sub.add_parser("list", help="列出某知识库的全部 Wiki 页面")
    p.add_argument("--kb-id", type=int, required=True)
    p = page_sub.add_parser("detail", help="查看单个 Wiki 页面正文与出处")
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--page-key", required=True)
    p = wiki_sub.add_parser("lint", help="Wiki 体检（断链 / 缺页 / 待审批补丁）")
    p.add_argument("--kb-id", type=int, required=True)
    p = wiki_sub.add_parser("ingest", help="增量 / 强制重建知识库的 Wiki")
    p.add_argument("--kb-id", type=int, required=True)
    p.add_argument("--article-id", type=int, action="append", help="可重复，只重建这些文章；省略则整库增量")
    p.add_argument("--force", action="store_true", help="忽略缓存整体重建")
    p.add_argument("--full", action="store_true", help="完全重建：先清空该知识库现有 Wiki 再编译")

    return parser


COMMANDS = {
    ("capabilities", None): cmd_capabilities,
    ("manifest", None): cmd_manifest,
    ("kb", "list"): cmd_kb_list,
    ("kb", "tree"): cmd_kb_tree,
    ("folder", "create"): cmd_folder_create,
    ("article", "create"): cmd_article_create,
    ("article", "update"): cmd_article_update,
    ("article", "delete"): cmd_article_delete,
    ("article", "list"): cmd_article_list,
    ("article", "move"): cmd_article_move,
    ("doc", "view"): cmd_doc_view,
    ("doc", "search"): cmd_doc_search,
    ("doc", "tree"): cmd_doc_tree,
    ("doc", "semantic"): cmd_doc_semantic,
    ("doc", "ask"): cmd_doc_ask,
    ("share", "create"): cmd_share_create,
    ("share", "revoke"): cmd_share_revoke,
    ("share", "info"): cmd_share_info,
    ("summary", "generate"): cmd_summary_generate,
    ("mindmap", "generate"): cmd_mindmap_generate,
    ("wiki", "page-list"): cmd_wiki_page_list,
    ("wiki", "page-detail"): cmd_wiki_page_detail,
    ("wiki", "lint"): cmd_wiki_lint,
    ("wiki", "ingest"): cmd_wiki_ingest,
}


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    sub_attr = {
        "kb": "kb_cmd",
        "folder": "folder_cmd",
        "article": "article_cmd",
        "doc": "doc_cmd",
        "share": "share_cmd",
        "summary": "summary_cmd",
        "mindmap": "mindmap_cmd",
        "wiki": "wiki_cmd",
    }.get(args.command)
    sub_value = getattr(args, sub_attr) if sub_attr else None
    if args.command == "wiki" and sub_value == "page":
        sub_value = f"page-{args.wiki_page_cmd}"
    handler = COMMANDS.get((args.command, sub_value))
    if handler is None:
        parser.error(f"unknown command: {args.command} {sub_value or ''}")
        return EXIT_USAGE
    handler(args)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
`
}

function createZip(files: AgentSkillPackageFile[]) {
    const localParts: Buffer[] = []
    const centralParts: Buffer[] = []
    let offset = 0

    for (const file of files) {
        const name = Buffer.from(file.path, "utf8")
        const data = Buffer.from(file.content, "utf8")
        const crc = crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0, 6)
        local.writeUInt16LE(0, 8)
        local.writeUInt16LE(0, 10)
        local.writeUInt16LE(0, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)
        localParts.push(local, name, data)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(0, 8)
        central.writeUInt16LE(0, 10)
        central.writeUInt16LE(0, 12)
        central.writeUInt16LE(0, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(data.length, 20)
        central.writeUInt32LE(data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt16LE(0, 30)
        central.writeUInt16LE(0, 32)
        central.writeUInt16LE(0, 34)
        central.writeUInt16LE(0, 36)
        central.writeUInt32LE(0, 38)
        central.writeUInt32LE(offset, 42)
        centralParts.push(central, name)

        offset += local.length + name.length + data.length
    }

    const centralDirectory = Buffer.concat(centralParts)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(centralDirectory.length, 12)
    end.writeUInt32LE(offset, 16)
    end.writeUInt16LE(0, 20)

    return Buffer.concat([...localParts, centralDirectory, end])
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    return value >>> 0
})

function crc32(data: Buffer) {
    let crc = 0xffffffff
    for (const byte of data) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}
