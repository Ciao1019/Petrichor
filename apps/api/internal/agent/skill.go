package agent

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type agentSkillFile struct {
	Path       string
	Content    string
	Executable bool
}

func normalizeAgentBaseURL(baseURL string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return "https://your-petrichor.example.com"
	}
	return baseURL
}

func buildAgentSkillMarkdown(baseURL string) string {
	baseURL = normalizeAgentBaseURL(baseURL)
	return fmt.Sprintf(`---
name: petrichor
description: Use this skill when an AI agent needs to call the Petrichor external Agent API for knowledge bases, articles, document search, document viewing, document question answering, article sharing, AI summary or mindmap generation, and Wiki operations.
---

# Petrichor

这是兼容旧入口的单文件 Skill。推荐下载完整 Skill 包；完整包会按 articles、docs、qa、share、ai、wiki、setup 拆分说明，并附带 CLI：

~~~bash
curl -L "%s/api/agent/skill-pack" -o petrichor-agent-skills.zip
~~~

## 环境变量

~~~bash
export PETRICHOR_BASE_URL="%s"
export PETRICHOR_API_KEY="ptc_live_xxx"
~~~

## 通用规则

- 不要输出、提交或记录完整 API Key。
- 受保护接口必须带 Authorization: Bearer $PETRICHOR_API_KEY。
- 删除文章前必须向用户复述文章 ID 和标题，并获得明确确认。
- 启用分享密码、设置到期时间、撤销分享前，先查询并复述当前分享状态。
- 触发 summary、mindmap 或 Wiki ingest 前，说明会调用模型且可能产生费用。
- 不确定知识库或文章 ID 时，先查 manifest、capabilities、知识库列表和文档搜索，不要猜。

## 快速自检

~~~bash
curl -sS "$PETRICHOR_BASE_URL/api/agent/manifest"
curl -sS "$PETRICHOR_BASE_URL/api/agent/capabilities" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY"
~~~

## 示例

创建文章：

~~~bash
curl -sS -X POST "$PETRICHOR_BASE_URL/api/agent/article/create" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"knowledgeBaseId":"1","title":"标题","contentMd":"# 标题\n\n正文","tags":["agent"]}'
~~~

文档问答：

~~~bash
curl -sS -X POST "$PETRICHOR_BASE_URL/api/agent/document/qa" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question":"问题","knowledgeBaseId":"1","limit":6}'
~~~
`, baseURL, baseURL)
}

func buildAgentSkillPackageZip(baseURL string) ([]byte, error) {
	baseURL = normalizeAgentBaseURL(baseURL)
	manifest, err := json.MarshalIndent(buildAgentManifest(baseURL), "", "  ")
	if err != nil {
		return nil, err
	}
	files := []agentSkillFile{
		{Path: "petrichor/SKILL.md", Content: buildAgentRootSkillMarkdown(baseURL)},
		{Path: "petrichor/config.json", Content: fmt.Sprintf("{\n  \"baseUrl\": %q,\n  \"apiKey\": \"ptc_live_xxx\"\n}\n", baseURL)},
		{Path: "petrichor/skills/setup.md", Content: buildAgentSetupSkillMarkdown(baseURL)},
		{Path: "petrichor/skills/articles.md", Content: agentArticlesSkillMarkdown},
		{Path: "petrichor/skills/docs.md", Content: agentDocsSkillMarkdown},
		{Path: "petrichor/skills/qa.md", Content: agentQASkillMarkdown},
		{Path: "petrichor/skills/share.md", Content: agentShareSkillMarkdown},
		{Path: "petrichor/skills/ai.md", Content: agentAISkillMarkdown},
		{Path: "petrichor/skills/wiki.md", Content: agentWikiSkillMarkdown},
		{Path: "petrichor/scripts/petrichor", Content: agentPythonCLI, Executable: true},
		{Path: "petrichor/scripts/petrichor-api.sh", Content: agentShellCLI, Executable: true},
		{Path: "petrichor/references/endpoints.md", Content: agentEndpointReference},
		{Path: "petrichor/assets/manifest.json", Content: string(manifest) + "\n"},
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, file := range files {
		header := &zip.FileHeader{Name: file.Path, Method: zip.Deflate}
		if file.Executable {
			header.SetMode(0o755)
		} else {
			header.SetMode(0o644)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			_ = writer.Close()
			return nil, err
		}
		if _, err := entry.Write([]byte(file.Content)); err != nil {
			_ = writer.Close()
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func buildAgentRootSkillMarkdown(baseURL string) string {
	return fmt.Sprintf(`---
name: petrichor
description: Petrichor external Agent API skill for knowledge-base browsing, article CRUD, folders, hybrid file search, document QA, sharing, AI generation, and file Wiki operations.
---

# Petrichor

Petrichor 的外部 Agent 入口。根据用户意图按需读取一个或多个子文档，不要一次加载全部说明。

## 配置

编辑 config.json：

~~~json
{"baseUrl": %q, "apiKey": "ptc_live_xxx"}
~~~

## 路由

| 用户意图 | 子文档 |
| --- | --- |
| 配置、自检、权限、发现接口 | skills/setup.md |
| 创建、更新、删除、移动文章或创建文件夹 | skills/articles.md |
| 浏览知识库、搜索、查看正文 | skills/docs.md |
| 文档问答 | skills/qa.md |
| 分享链接、密码、到期、撤销 | skills/share.md |
| AI 摘要、思维导图 | skills/ai.md |
| Wiki 页面、ingest、lint | skills/wiki.md |

## 全局安全规则

- 不泄露 API Key；所有受保护请求使用 Bearer 鉴权。
- 删除文章和撤销分享前必须取得明确确认。
- AI 生成与 Wiki ingest 前告知模型调用成本。
- ID 必须通过列表或搜索获得，禁止猜测。
- 详细 JSON 字段与 18 个工具对应端点见 references/endpoints.md。
`, baseURL)
}

func buildAgentSetupSkillMarkdown(baseURL string) string {
	return fmt.Sprintf(`# Setup

1. 在 config.json 中设置站点 %s 与明文 Agent API Key。
2. 执行 chmod +x scripts/petrichor scripts/petrichor-api.sh。
3. 运行 scripts/petrichor manifest 和 scripts/petrichor capabilities 自检。
4. 401 表示 Key 无效/过期；403 表示缺少对应 scope。

MCP 可直接连接 %s/api/mcp，传 Authorization: Bearer <apiKey>。
`, baseURL, baseURL)
}

const agentArticlesSkillMarkdown = `# Articles

工作流：先查知识库与目录树，再创建文件夹或文章；更新文章必须提交完整标题与 Markdown；移动时明确目标父目录与 targetIndex。删除前先查看文章并让用户确认。

~~~bash
scripts/petrichor call knowledgeBaseList '{}'
scripts/petrichor call knowledgeBaseTree '{"knowledgeBaseId":"1"}'
scripts/petrichor call folderCreate '{"knowledgeBaseId":"1","name":"目录","parentId":null}'
scripts/petrichor call articleCreate '{"knowledgeBaseId":"1","title":"标题","contentMd":"正文","tags":[]}'
scripts/petrichor call articleUpdate '{"articleId":"2","title":"标题","contentMd":"完整正文","tags":[]}'
scripts/petrichor call articleMove '{"articleId":"2","parentId":null,"targetIndex":0}'
scripts/petrichor call articleDelete '{"articleId":"2"}'
~~~
`

const agentDocsSkillMarkdown = `# Docs

先列知识库和目录树；统一用 documentSearch 混合检索文件分片、Wiki 页面与文章，最后用 documentView 获取完整正文。

~~~bash
scripts/petrichor call articleList '{"knowledgeBaseId":"1","parentScope":"ANY","tags":[],"keyword":"","limit":50}'
scripts/petrichor call documentSearch '{"query":"关键词","knowledgeBaseId":"1","limit":8}'
scripts/petrichor call documentView '{"articleId":"2"}'
scripts/petrichor call documentView '{"knowledgeBaseId":"1","pageKey":"index"}'
~~~
`

const agentQASkillMarkdown = `# QA

限定知识库时传 knowledgeBaseId；跨库问答时省略。使用 answer 和 citations 作答；如果提示依据不足，不得编造，应回到 docs 搜索扩大上下文。

~~~bash
scripts/petrichor call documentQa '{"question":"这里写问题","knowledgeBaseId":"1","limit":6}'
~~~
`

const agentShareSkillMarkdown = `# Share

分享写操作需要 share:write。修改密码、过期时间或撤销前先调用 articleShareInfo 并复述当前状态；密码只能是 6 位数字；expiresAt 必须是未来 ISO 8601 时间。

~~~bash
scripts/petrichor call articleShareInfo '{"articleId":"2"}'
scripts/petrichor call articleShareCreate '{"articleId":"2","passwordEnabled":true,"accessPassword":"123456","expiresAt":"2027-12-31T23:59:59Z"}'
scripts/petrichor call articleShareRevoke '{"articleId":"2"}'
~~~
`

const agentAISkillMarkdown = `# AI

摘要和思维导图会调用默认 CHAT 模型并可能产生费用。默认复用缓存；只有用户明确要求时才 forceRebuild。

~~~bash
scripts/petrichor call articleSummaryGenerate '{"articleId":"2","forceRebuild":false}'
scripts/petrichor call articleMindmapGenerate '{"articleId":"2","mode":"MINDMAP","forceRebuild":false}'
~~~
`

const agentWikiSkillMarkdown = `# Wiki

先列页面，再按 pageKey 读取正文、文件分片来源和出链，或执行 lint。ingest 可能调用模型；可传最多 500 个 documentIds 做局部构建，forceRebuild 会忽略缓存。

~~~bash
scripts/petrichor call wikiPageList '{"knowledgeBaseId":"1"}'
scripts/petrichor call wikiPageDetail '{"knowledgeBaseId":"1","pageKey":"index"}'
scripts/petrichor call wikiLint '{"knowledgeBaseId":"1"}'
scripts/petrichor call wikiIngest '{"knowledgeBaseId":"1","documentIds":["2"],"forceRebuild":false}'
~~~
`

const agentPythonCLI = `#!/usr/bin/env python3
"""Zero-dependency Petrichor Agent API helper."""
import json, os, pathlib, sys, urllib.error, urllib.request

ENDPOINTS = {
  "manifest": ["GET", "/api/agent/manifest", False],
  "capabilities": ["GET", "/api/agent/capabilities", True],
  "knowledgeBaseList": ["POST", "/api/agent/knowledge-base/list", True],
  "knowledgeBaseTree": ["POST", "/api/agent/knowledge-base/tree", True],
  "folderCreate": ["POST", "/api/agent/folder/create", True],
  "articleCreate": ["POST", "/api/agent/article/create", True],
  "articleUpdate": ["POST", "/api/agent/article/update", True],
  "articleDelete": ["POST", "/api/agent/article/delete", True],
  "articleList": ["POST", "/api/agent/article/list", True],
  "articleMove": ["POST", "/api/agent/article/move", True],
  "articleShareCreate": ["POST", "/api/agent/article/share/create", True],
  "articleShareRevoke": ["POST", "/api/agent/article/share/revoke", True],
  "articleShareInfo": ["POST", "/api/agent/article/share/info", True],
  "articleSummaryGenerate": ["POST", "/api/agent/article/summary/generate", True],
  "articleMindmapGenerate": ["POST", "/api/agent/article/mindmap/generate", True],
  "documentSearch": ["POST", "/api/agent/document/search", True],
  "documentView": ["POST", "/api/agent/document/view", True],
  "documentQa": ["POST", "/api/agent/document/qa", True],
  "wikiPageList": ["POST", "/api/agent/wiki/page/list", True],
  "wikiPageDetail": ["POST", "/api/agent/wiki/page/detail", True],
  "wikiLint": ["POST", "/api/agent/wiki/lint", True],
  "wikiIngest": ["POST", "/api/agent/wiki/ingest", True],
}

def config():
  path = pathlib.Path(__file__).resolve().parent.parent / "config.json"
  data = json.loads(path.read_text("utf-8")) if path.exists() else {}
  return (os.getenv("PETRICHOR_BASE_URL") or data.get("baseUrl", "")).rstrip("/"), os.getenv("PETRICHOR_API_KEY") or data.get("apiKey", "")

def main():
  if len(sys.argv) == 2 and sys.argv[1] in ("manifest", "capabilities"):
    name, payload = sys.argv[1], None
  elif len(sys.argv) == 4 and sys.argv[1] == "call":
    name, payload = sys.argv[2], json.loads(sys.argv[3])
  else:
    sys.stderr.write("usage: petrichor manifest|capabilities | petrichor call <endpointName> '<json>'\n")
    return 2
  if name not in ENDPOINTS:
    sys.stderr.write("unknown endpoint; see references/endpoints.md\n")
    return 2
  base, key = config(); method, path, auth = ENDPOINTS[name]
  if not base or (auth and (not key or key == "ptc_live_xxx")):
    sys.stderr.write("configure baseUrl/apiKey in config.json\n"); return 2
  body = None if payload is None else json.dumps(payload).encode()
  headers = {"Accept": "application/json"}
  if body is not None: headers["Content-Type"] = "application/json"
  if auth: headers["Authorization"] = "Bearer " + key
  try:
    with urllib.request.urlopen(urllib.request.Request(base + path, body, headers, method=method)) as response:
      print(json.dumps(json.loads(response.read()), ensure_ascii=False, indent=2)); return 0
  except urllib.error.HTTPError as error:
    sys.stderr.write(error.read().decode("utf-8", "replace") + "\n"); return 1

if __name__ == "__main__": raise SystemExit(main())
`

const agentShellCLI = `#!/bin/sh
set -eu
if [ "$#" -lt 1 ]; then echo "usage: petrichor-api.sh PATH [JSON]" >&2; exit 2; fi
: "${PETRICHOR_BASE_URL:?set PETRICHOR_BASE_URL}"
: "${PETRICHOR_API_KEY:?set PETRICHOR_API_KEY}"
path="$1"; data="${2:-{}}"
curl -sS -X POST "${PETRICHOR_BASE_URL%/}${path}" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \
  -H "Content-Type: application/json" -d "$data"
`

const agentEndpointReference = `# Petrichor Agent endpoint reference

所有 POST 请求使用 JSON；除 manifest、skill、skill-pack 外均使用 Bearer API Key。ID 接受正整数或十进制字符串。

| 名称 | Scope | 路径 | 主要输入 |
| --- | --- | --- | --- |
| knowledgeBaseList | doc:read | POST /api/agent/knowledge-base/list | {} |
| knowledgeBaseTree | doc:read | POST /api/agent/knowledge-base/tree | knowledgeBaseId |
| articleList | doc:read | POST /api/agent/article/list | knowledgeBaseId, parentId?, parentScope?, tags?, keyword?, limit? |
| folderCreate | article:write | POST /api/agent/folder/create | knowledgeBaseId, name, parentId? |
| articleCreate | article:write | POST /api/agent/article/create | knowledgeBaseId, parentId?, title, contentMd, contentJson?, contentMetaJson?, tags? |
| articleUpdate | article:write | POST /api/agent/article/update | articleId, title, contentMd, contentJson?, contentMetaJson?, tags? |
| articleDelete | article:delete | POST /api/agent/article/delete | articleId |
| articleMove | article:write | POST /api/agent/article/move | articleId, parentId, targetIndex? |
| documentSearch | doc:read | POST /api/agent/document/search | query(1..200), knowledgeBaseId?, limit(1..20) |
| documentView | doc:read | POST /api/agent/document/view | articleId，或 knowledgeBaseId + pageKey |
| documentQa | qa:read | POST /api/agent/document/qa | question(1..1000), knowledgeBaseId?, configId?, limit(1..10) |
| articleShareCreate | share:write | POST /api/agent/article/share/create | articleId, passwordEnabled?, accessPassword?, expiresAt? |
| articleShareInfo | share:write | POST /api/agent/article/share/info | articleId |
| articleShareRevoke | share:write | POST /api/agent/article/share/revoke | articleId |
| articleSummaryGenerate | ai:write | POST /api/agent/article/summary/generate | articleId, forceRebuild? |
| articleMindmapGenerate | ai:write | POST /api/agent/article/mindmap/generate | articleId, mode(MINDMAP), forceRebuild? |
| wikiPageList | wiki:read | POST /api/agent/wiki/page/list | knowledgeBaseId |
| wikiPageDetail | wiki:read | POST /api/agent/wiki/page/detail | knowledgeBaseId, pageKey |
| wikiLint | wiki:read | POST /api/agent/wiki/lint | knowledgeBaseId |
| wikiIngest | wiki:write | POST /api/agent/wiki/ingest | knowledgeBaseId, documentIds?(最多500), forceRebuild? |

响应为 JSON；错误结构为 { code, msg, path, timestamp }。删除、撤销和模型调用遵循 SKILL.md 的确认规则。
`
