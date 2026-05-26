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
        documentView: "/api/agent/document/view",
        documentQa: "/api/agent/document/qa",
        legacySkill: "/api/agent/skill",
        skillPack: "/api/agent/skill-pack",
    }
}

export function buildAgentManifest(baseUrl: string) {
    return {
        name: "Petrichor Agent API",
        version: "2026-05-26",
        baseUrl: normalizeAgentBaseUrl(baseUrl),
        auth: {
            type: "bearer",
            env: "PETRICHOR_API_KEY",
            header: "Authorization: Bearer <apiKey>",
        },
        requiredHeaders: {
            "X-Petrichor-Agent-Source": "调用方标识，例如 claude-code、codex、openclaw、custom-agent",
            "X-Petrichor-Agent-Tool": "可选，具体 Skill 或工具名，例如 petrichor-articles",
        },
        env: {
            PETRICHOR_BASE_URL: normalizeAgentBaseUrl(baseUrl),
            PETRICHOR_API_KEY: "ptc_live_xxx",
            PETRICHOR_AGENT_SOURCE: "codex",
            PETRICHOR_AGENT_TOOL: "petrichor-setup",
        },
        scopes: {
            "article:write": ["article.create", "article.update", "article.move", "folder.create"],
            "article:delete": ["article.delete"],
            "doc:read": ["knowledge-base.list", "knowledge-base.tree", "article.list", "document.search", "document.view"],
            "qa:read": ["document.qa"],
            "share:write": ["article.share.create", "article.share.revoke", "article.share.info"],
            "ai:write": ["article.summary.generate", "article.mindmap.generate"],
        },
        endpoints: buildAgentEndpointMap(),
    }
}

export function buildAgentSkillMarkdown(baseUrl: string) {
    const normalizedBaseUrl = normalizeAgentBaseUrl(baseUrl)
    const endpoints = buildAgentEndpointMap()

    return `---
name: petrichor-agent
description: Use this skill when an AI agent needs to call Petrichor external Agent API for knowledge bases, articles, document search, document viewing, or document question answering.
---

# Petrichor Agent

这是兼容旧入口的单文件 Skill。更推荐下载完整多 Skill 包：

\`\`\`bash
curl -L "${normalizedBaseUrl}${endpoints.skillPack}" -o petrichor-agent-skills.zip
\`\`\`

## 环境变量

\`\`\`bash
export PETRICHOR_BASE_URL="${normalizedBaseUrl}"
export PETRICHOR_API_KEY="ptc_live_xxx"
export PETRICHOR_AGENT_SOURCE="codex"
export PETRICHOR_AGENT_TOOL="petrichor-agent"
\`\`\`

## 通用规则

- 推荐用 Skill 包内附带的 \`scripts/petrichor\` CLI（零依赖 Python 3.8+）代替裸 curl，错误信息更友好。
- 不要输出完整 API Key。
- 所有受保护接口带上 \`Authorization: Bearer $PETRICHOR_API_KEY\`。
- 所有受保护接口必须带上 \`X-Petrichor-Agent-Source\`，否则调用失败并写入审计日志。
- 删除文章前必须向用户复述文章 ID 和标题，并获得明确确认。
- 启用分享密码、设置到期时间、撤销分享前，先用 \`share info\` 复述当前状态。
- 触发 AI 生成（summary、mindmap）前，先告诉用户会调用模型可能产生费用。
- 不确定知识库或文章 ID 时，先查 manifest、capabilities、知识库列表和文档搜索。

## 快速命令

\`\`\`bash
curl -sS "$PETRICHOR_BASE_URL${endpoints.manifest}"
curl -sS "$PETRICHOR_BASE_URL${endpoints.capabilities}" \\
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
  -H "X-Petrichor-Agent-Source: $PETRICHOR_AGENT_SOURCE" \\
  -H "X-Petrichor-Agent-Tool: \${PETRICHOR_AGENT_TOOL:-petrichor-agent}"
\`\`\`

文章：

\`\`\`bash
curl -sS -X POST "$PETRICHOR_BASE_URL${endpoints.articleCreate}" \\
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
  -H "X-Petrichor-Agent-Source: $PETRICHOR_AGENT_SOURCE" \\
  -H "X-Petrichor-Agent-Tool: \${PETRICHOR_AGENT_TOOL:-petrichor-agent}" \\
  -H "Content-Type: application/json" \\
  -d '{"knowledgeBaseId":"1","title":"标题","contentMd":"# 标题\\n\\n正文","tags":["agent"]}'
\`\`\`

文档问答：

\`\`\`bash
curl -sS -X POST "$PETRICHOR_BASE_URL${endpoints.documentQa}" \\
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
  -H "X-Petrichor-Agent-Source: $PETRICHOR_AGENT_SOURCE" \\
  -H "X-Petrichor-Agent-Tool: \${PETRICHOR_AGENT_TOOL:-petrichor-agent}" \\
  -H "Content-Type: application/json" \\
  -d '{"question":"问题","knowledgeBaseId":"1","limit":6}'
\`\`\`
`
}

export function buildAgentSkillPackageFiles(baseUrl: string): AgentSkillPackageFile[] {
    const normalizedBaseUrl = normalizeAgentBaseUrl(baseUrl)
    const manifest = buildAgentManifest(normalizedBaseUrl)
    const helper = buildApiHelperScript()
    const commonReference = buildCommonEndpointReference()
    const pythonCli = buildPetrichorPythonCli()

    const skills: Array<{ id: string; markdown: string }> = [
        { id: "petrichor-setup", markdown: buildSetupSkillMarkdown(normalizedBaseUrl) },
        { id: "petrichor-articles", markdown: buildArticleSkillMarkdown() },
        { id: "petrichor-docs", markdown: buildDocsSkillMarkdown() },
        { id: "petrichor-qa", markdown: buildQaSkillMarkdown() },
        { id: "petrichor-share", markdown: buildShareSkillMarkdown() },
        { id: "petrichor-ai", markdown: buildAiSkillMarkdown() },
    ]

    const files: AgentSkillPackageFile[] = []
    for (const skill of skills) {
        files.push({ path: `${skill.id}/SKILL.md`, content: skill.markdown })
        files.push({ path: `${skill.id}/scripts/petrichor`, content: pythonCli })
        files.push({ path: `${skill.id}/scripts/petrichor-api.sh`, content: helper })
        files.push({ path: `${skill.id}/references/endpoints.md`, content: commonReference })
    }
    files.push({
        path: "petrichor-setup/assets/manifest.json",
        content: JSON.stringify(manifest, null, 2),
    })
    return files
}

export function buildAgentSkillPackageZip(baseUrl: string) {
    return createZip(buildAgentSkillPackageFiles(baseUrl))
}

function buildSetupSkillMarkdown(baseUrl: string) {
    return `---
name: petrichor-setup
description: Use this skill when configuring or diagnosing Petrichor Agent API access, checking API key scopes, discovering endpoint URLs, or installing Petrichor skills for Claude Code, Codex, OpenClaw, or similar agent tools.
---

# Petrichor Setup

## 安装 CLI

Skill 内置了一个零依赖的 Python CLI（仅需 Python 3.8+，使用标准库）。首次使用前赋予执行权限：

\`\`\`bash
chmod +x scripts/petrichor
\`\`\`

> 如果运行环境没有 Python，可以回退到 \`scripts/petrichor-api.sh\`（curl 版本，功能等价）。

## 环境变量

确认终端里有：

\`\`\`bash
export PETRICHOR_BASE_URL="${baseUrl}"
export PETRICHOR_API_KEY="ptc_live_xxx"
export PETRICHOR_AGENT_SOURCE="codex"
export PETRICHOR_AGENT_TOOL="petrichor-setup"
\`\`\`

不要把完整 API Key 写入文件、提交、日志或最终回复。必须设置 \`PETRICHOR_AGENT_SOURCE\`，
例如 \`claude-code\`、\`codex\`、\`openclaw\` 或更具体的内部工具名。

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
`
}

function buildArticleSkillMarkdown() {
    return `---
name: petrichor-articles
description: Use this skill when creating, updating, organizing, or deleting Petrichor knowledge-base articles through the external Agent API. Triggers include new article, update article, create folder, move content into a knowledge base, or delete article requests.
---

# Petrichor Articles

执行前设置：

\`\`\`bash
export PETRICHOR_AGENT_TOOL="petrichor-articles"
\`\`\`

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

function buildDocsSkillMarkdown() {
    return `---
name: petrichor-docs
description: Use this skill when searching, browsing, listing, or reading Petrichor knowledge bases, article trees, source articles, and Wiki pages through the external Agent API.
---

# Petrichor Docs

执行前设置：

\`\`\`bash
export PETRICHOR_AGENT_TOOL="petrichor-docs"
\`\`\`

## 工作流

1. 先 \`scripts/petrichor kb list\` 找知识库。
2. 需要目录结构时 \`scripts/petrichor kb tree --kb-id <ID>\`。
3. 平铺列出某知识库的文章用 \`scripts/petrichor article list --kb-id <ID>\`，可加 \`--tag\` / \`--keyword\` / \`--parent-id\` / \`--direct\` 过滤。
4. 搜索内容 \`scripts/petrichor doc search\`；跨库搜索时省略 \`--kb-id\`。
5. 读取原文 \`scripts/petrichor doc view --article-id <ID>\`。
6. 读取 Wiki 页面 \`scripts/petrichor doc view --kb-id <ID> --page-key <key>\`。

## 命令

\`\`\`bash
scripts/petrichor article list --kb-id 1 --tag draft --keyword 周报 --limit 20
scripts/petrichor article list --kb-id 1 --parent-id 5 --direct
scripts/petrichor doc search --query "关键词" --kb-id 1 --limit 8
scripts/petrichor doc view --article-id 123
scripts/petrichor doc view --kb-id 1 --page-key index
\`\`\`

详细字段见 \`references/endpoints.md\`。
`
}

function buildQaSkillMarkdown() {
    return `---
name: petrichor-qa
description: Use this skill when answering questions from Petrichor knowledge bases or documents through the external Agent API. Triggers include document QA, summarize from knowledge base, compare notes, cite source documents, or answer from Petrichor content.
---

# Petrichor QA

执行前设置：

\`\`\`bash
export PETRICHOR_AGENT_TOOL="petrichor-qa"
\`\`\`

## 工作流

1. 如果用户限定知识库，传 \`--kb-id\`。
2. 如果用户没有限定知识库，省略 \`--kb-id\`，使用跨库问答。
3. 回答时优先使用接口返回的 \`answer\` 和 \`citations\`。
4. 如果返回"未找到足够依据"，不要编造；改用 \`petrichor-docs\` 搜索更多上下文。

## 命令

\`\`\`bash
scripts/petrichor doc ask --question "这里写问题" --kb-id 1 --limit 6
scripts/petrichor doc ask --question "跨库的问题"
\`\`\`

详细字段见 \`references/endpoints.md\`。
`
}

function buildShareSkillMarkdown() {
    return `---
name: petrichor-share
description: Use this skill when publishing, unpublishing, password-protecting, or setting expiry on Petrichor article share links through the external Agent API. Triggers include "share article", "make public", "set share password", "set share expiry", "revoke share", or "unpublish article".
---

# Petrichor Share

执行前设置：

\`\`\`bash
export PETRICHOR_AGENT_TOOL="petrichor-share"
\`\`\`

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

返回中的 \`shareUrl\` 是相对路径，对外完整链接需要拼接 \`PETRICHOR_BASE_URL\`。
`
}

function buildAiSkillMarkdown() {
    return `---
name: petrichor-ai
description: Use this skill when triggering AI summary or mindmap generation for Petrichor articles through the external Agent API. Triggers include "summarize article", "generate summary", "generate mindmap", "generate knowledge graph", or "refresh AI summary".
---

# Petrichor AI

执行前设置：

\`\`\`bash
export PETRICHOR_AGENT_TOOL="petrichor-ai"
\`\`\`

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

function buildApiHelperScript() {
    return `#!/usr/bin/env bash
set -euo pipefail

method="\${1:-}"
path="\${2:-}"
body="\${3:-}"

if [[ -z "\${PETRICHOR_BASE_URL:-}" ]]; then
  echo "缺少 PETRICHOR_BASE_URL" >&2
  exit 2
fi

if [[ -z "\${PETRICHOR_API_KEY:-}" ]]; then
  echo "缺少 PETRICHOR_API_KEY" >&2
  exit 2
fi

if [[ -z "\${PETRICHOR_AGENT_SOURCE:-}" ]]; then
  echo "缺少 PETRICHOR_AGENT_SOURCE，外部 Agent 调用必须声明来源方" >&2
  exit 2
fi

if [[ -z "$method" || -z "$path" ]]; then
  echo "用法: bash scripts/petrichor-api.sh METHOD /api/agent/path JSON_BODY" >&2
  exit 2
fi

base="\${PETRICHOR_BASE_URL%/}"
url="$base$path"

if [[ -n "$body" ]]; then
  curl -sS -X "$method" "$url" \\
    -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
    -H "X-Petrichor-Agent-Source: $PETRICHOR_AGENT_SOURCE" \\
    -H "X-Petrichor-Agent-Tool: \${PETRICHOR_AGENT_TOOL:-unknown}" \\
    -H "Content-Type: application/json" \\
    -d "$body"
else
  curl -sS -X "$method" "$url" \\
    -H "Authorization: Bearer $PETRICHOR_API_KEY" \\
    -H "X-Petrichor-Agent-Source: $PETRICHOR_AGENT_SOURCE" \\
    -H "X-Petrichor-Agent-Tool: \${PETRICHOR_AGENT_TOOL:-unknown}" \\
    -H "Content-Type: application/json"
fi
`
}

function buildCommonEndpointReference() {
    return `# Petrichor Agent API Endpoints

## 鉴权

所有受保护接口使用：

\`\`\`http
Authorization: Bearer <PETRICHOR_API_KEY>
X-Petrichor-Agent-Source: <claude-code|codex|openclaw|custom>
X-Petrichor-Agent-Tool: <可选的 skill 或工具名>
\`\`\`

缺少 \`X-Petrichor-Agent-Source\` 时，接口会失败并写入审计日志。

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
- \`POST /api/agent/document/view\`
  - scope: \`doc:read\`
  - 读取文章：\`{"articleId":"123"}\`
  - 读取 Wiki：\`{"knowledgeBaseId":"1","pageKey":"index"}\`

## 问答

- \`POST /api/agent/document/qa\`
  - scope: \`qa:read\`
  - body: \`{"question":"问题","knowledgeBaseId":"1","limit":6}\`
  - 跨库问答时省略 \`knowledgeBaseId\`。
`
}

function buildPetrichorPythonCli() {
    return `#!/usr/bin/env python3
"""
Petrichor Agent CLI — zero-dep wrapper around the Petrichor external Agent API.

Requires Python 3.8+. Uses only the standard library (urllib, argparse, json).

Environment variables (required unless noted):
  PETRICHOR_BASE_URL       e.g. https://petrichor.example.com
  PETRICHOR_API_KEY        Agent API Key generated in the Petrichor dashboard
  PETRICHOR_AGENT_SOURCE   caller identity (e.g. claude-code, codex, openclaw)
  PETRICHOR_AGENT_TOOL     (optional) specific skill / tool name

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

DEFAULT_AGENT_TOOL = "petrichor-cli"


def _env(name: str, required: bool = True) -> Optional[str]:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if required:
        sys.stderr.write(f"[petrichor] Missing required env var {name}\\n")
        sys.exit(EXIT_CONFIG)
    return None


def _request(
    method: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    require_auth: bool = True,
) -> Dict[str, Any]:
    base_url = _env("PETRICHOR_BASE_URL").rstrip("/")
    url = base_url + path
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if require_auth:
        headers["Authorization"] = f"Bearer {_env('PETRICHOR_API_KEY')}"
        headers["X-Petrichor-Agent-Source"] = _env("PETRICHOR_AGENT_SOURCE")
        headers["X-Petrichor-Agent-Tool"] = os.environ.get("PETRICHOR_AGENT_TOOL", DEFAULT_AGENT_TOOL)

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
    ("doc", "ask"): cmd_doc_ask,
    ("share", "create"): cmd_share_create,
    ("share", "revoke"): cmd_share_revoke,
    ("share", "info"): cmd_share_info,
    ("summary", "generate"): cmd_summary_generate,
    ("mindmap", "generate"): cmd_mindmap_generate,
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
    }.get(args.command)
    sub_value = getattr(args, sub_attr) if sub_attr else None
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
