// discover.go 对照 skill.ts 与 handlers.ts 的发现类端点：manifest / capabilities / skill / skill-pack。
package agentapi

import (
	"archive/zip"
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

// agentEndpointMap 对应 skill.ts buildAgentEndpointMap。
func agentEndpointMap() map[string]string {
	return map[string]string{
		"capabilities":           "/api/agent/capabilities",
		"manifest":               "/api/agent/manifest",
		"knowledgeBaseList":      "/api/agent/knowledge-base/list",
		"knowledgeBaseTree":      "/api/agent/knowledge-base/tree",
		"folderCreate":           "/api/agent/folder/create",
		"articleCreate":          "/api/agent/article/create",
		"articleUpdate":          "/api/agent/article/update",
		"articleDelete":          "/api/agent/article/delete",
		"articleList":            "/api/agent/article/list",
		"articleMove":            "/api/agent/article/move",
		"articleShareCreate":     "/api/agent/article/share/create",
		"articleShareRevoke":     "/api/agent/article/share/revoke",
		"articleShareInfo":       "/api/agent/article/share/info",
		"articleSummaryGenerate": "/api/agent/article/summary/generate",
		"articleMindmapGenerate": "/api/agent/article/mindmap/generate",
		"documentSearch":         "/api/agent/document/search",
		"documentTree":           "/api/agent/document/tree",
		"documentSemanticSearch": "/api/agent/document/semantic-search",
		"documentView":           "/api/agent/document/view",
		"documentQa":             "/api/agent/document/qa",
		"wikiPageList":           "/api/agent/wiki/page/list",
		"wikiPageDetail":         "/api/agent/wiki/page/detail",
		"wikiLint":               "/api/agent/wiki/lint",
		"wikiIngest":             "/api/agent/wiki/ingest",
		"legacySkill":            "/api/agent/skill",
		"skillPack":              "/api/agent/skill-pack",
	}
}

var trailingSlashesRe = regexp.MustCompile(`/+$`)

// normalizeAgentBaseUrl 对照 skill.ts 同名函数。
func normalizeAgentBaseUrl(baseUrl string) string {
	normalized := strings.TrimSpace(trailingSlashesRe.ReplaceAllString(baseUrl, ""))
	if normalized == "" {
		return "https://your-petrichor.example.com"
	}
	return normalized
}

// buildAgentMcpInfo 对应 skill.ts 同名函数。
func buildAgentMcpInfo(baseUrl string) map[string]any {
	return map[string]any{
		"endpoint":  normalizeAgentBaseUrl(baseUrl) + "/api/mcp",
		"transport": "streamable-http",
		"auth": map[string]any{
			"type":   "bearer",
			"header": "Authorization: Bearer <apiKey>",
		},
	}
}

func agentScopeManifest() map[string]any {
	return map[string]any{
		"article:write":  []string{"article.create", "article.update", "article.move", "folder.create"},
		"article:delete": []string{"article.delete"},
		"doc:read":       []string{"knowledge-base.list", "knowledge-base.tree", "article.list", "document.search", "document.tree", "document.semantic-search", "document.view"},
		"qa:read":        []string{"document.qa"},
		"share:write":    []string{"article.share.create", "article.share.revoke", "article.share.info"},
		"ai:write":       []string{"article.summary.generate", "article.mindmap.generate"},
		"wiki:read":      []string{"wiki.page.list", "wiki.page.detail", "wiki.lint"},
		"wiki:write":     []string{"wiki.ingest"},
	}
}

// buildAgentManifest 对应 skill.ts 同名函数。
func buildAgentManifest(baseUrl string) map[string]any {
	normalized := normalizeAgentBaseUrl(baseUrl)
	return map[string]any{
		"name":    "Petrichor Agent API",
		"version": "2026-06-08",
		"baseUrl": normalized,
		"mcp":     buildAgentMcpInfo(baseUrl),
		"auth": map[string]any{
			"type":   "bearer",
			"env":    "PETRICHOR_API_KEY",
			"header": "Authorization: Bearer <apiKey>",
		},
		"env": map[string]any{
			"PETRICHOR_BASE_URL": normalized,
			"PETRICHOR_API_KEY":  "ptc_live_xxx",
		},
		"scopes":    agentScopeManifest(),
		"endpoints": agentEndpointMap(),
	}
}

var agentCapabilities = []string{
	"knowledge-base.list",
	"knowledge-base.tree",
	"folder.create",
	"article.create",
	"article.update",
	"article.delete",
	"article.list",
	"article.move",
	"article.share.create",
	"article.share.revoke",
	"article.share.info",
	"article.summary.generate",
	"article.mindmap.generate",
	"document.search",
	"document.tree",
	"document.semantic-search",
	"document.view",
	"document.qa",
	"wiki.page.list",
	"wiki.page.detail",
	"wiki.lint",
	"wiki.ingest",
}

// getRequestBaseUrl 对照 handlers.ts getRequestBaseUrl：请求 origin（协议 + Host）。
func getRequestBaseUrl(c *gin.Context) string {
	scheme := "http"
	if proto := strings.TrimSpace(c.GetHeader("X-Forwarded-Proto")); proto != "" {
		scheme = proto
	} else if c.Request.TLS != nil {
		scheme = "https"
	}
	host := c.Request.Host
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// AgentCapabilities GET /api/agent/capabilities（任意有效 Key，不限 scope，照 TS 语义）。
func AgentCapabilities(c *gin.Context, actx *authContext) (any, error) {
	baseUrl := getRequestBaseUrl(c)
	kbItems, err := listUserKnowledgeBases(dbPool(), actx.UserID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"name":            "Petrichor Agent API",
		"version":         "2026-06-08",
		"baseUrl":         baseUrl,
		"keyPrefix":       actx.KeyPrefix,
		"scopes":          actx.Scopes,
		"supportedScopes": auth.AgentApiKeyScopes,
		"capabilities":    agentCapabilities,
		"manifest":        buildAgentManifest(baseUrl),
		"mcp":             buildAgentMcpInfo(baseUrl),
		"knowledgeBases":  kbItems,
	}, nil
}

// ManifestHandler GET /api/agent/manifest（公开，Cache-Control 300s）。
func ManifestHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "public, max-age=300")
		c.JSON(http.StatusOK, buildAgentManifest(getRequestBaseUrl(c)))
	}
}

// buildAgentSkillMarkdown 对照 skill.ts buildAgentSkillMarkdown。
func buildAgentSkillMarkdown(baseUrl string) string {
	normalizedBaseUrl := normalizeAgentBaseUrl(baseUrl)
	endpoints := agentEndpointMap()
	return `---
name: petrichor
description: Use this skill when an AI agent needs to call the Petrichor external Agent API for knowledge bases, articles, document search, document viewing, document question answering, article sharing, or AI summary / mindmap generation. Triggers include create / update / delete article, browse knowledge base, search docs, ask the knowledge base, share article, summarize article.
---

# Petrichor

兼容旧入口的单文件 Skill。推荐改用完整 Skill 包，里面是一个 ` + "`petrichor/`" + ` 顶层 skill，
内部按用户意图路由到 articles / docs / qa / share / ai / wiki / setup 子文档：

` + "```bash" + `
curl -L "` + normalizedBaseUrl + endpoints["skillPack"] + `" -o petrichor-skill.zip
` + "```" + `

## 环境变量

` + "```bash" + `
export PETRICHOR_BASE_URL="` + normalizedBaseUrl + `"
export PETRICHOR_API_KEY="ptc_live_xxx"
` + "```" + `

## 通用规则

- 推荐用 Skill 包内附带的 ` + "`scripts/petrichor`" + ` CLI（零依赖 Python 3.8+）代替裸 curl，错误信息更友好。
- 不要输出完整 API Key。
- 所有受保护接口带上 ` + "`Authorization: Bearer $PETRICHOR_API_KEY`" + `。
- 删除文章前必须向用户复述文章 ID 和标题，并获得明确确认。
- 启用分享密码、设置到期时间、撤销分享前，先用 ` + "`share info`" + ` 复述当前状态。
- 触发 AI 生成（summary、mindmap）前，先告诉用户会调用模型可能产生费用。
- 不确定知识库或文章 ID 时，先查 manifest、capabilities、知识库列表和文档搜索。

## 快速命令

` + "```bash" + `
curl -sS "$PETRICHOR_BASE_URL` + endpoints["manifest"] + `"
curl -sS "$PETRICHOR_BASE_URL` + endpoints["capabilities"] + `" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY"
` + "```" + `

文章：

` + "```bash" + `
curl -sS -X POST "$PETRICHOR_BASE_URL` + endpoints["articleCreate"] + `" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"knowledgeBaseId":"1","title":"标题","contentMd":"# 标题\n\n正文","tags":["agent"]}'
` + "```" + `

文档问答：

` + "```bash" + `
curl -sS -X POST "$PETRICHOR_BASE_URL` + endpoints["documentQa"] + `" \
  -H "Authorization: Bearer $PETRICHOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question":"问题","knowledgeBaseId":"1","limit":6}'
` + "```" + `
`
}

// SkillHandler GET /api/agent/skill：返回 SKILL.md 文本附件。
func SkillHandler() gin.HandlerFunc {
	return agentSkillBody
}

func agentSkillBody(c *gin.Context) {
	c.Header("Cache-Control", "public, max-age=300")
	c.Header("Content-Disposition", `attachment; filename="SKILL.md"`)
	c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(buildAgentSkillMarkdown(getRequestBaseUrl(c))))
}

// skillsSourceDir 返回 Skill 包源目录：
// 优先取 PETRICHOR_SKILLS_DIR；否则按 apps/web/skills 相对资源路径探测。
func skillsSourceDir() string {
	if dir := strings.TrimSpace(os.Getenv("PETRICHOR_SKILLS_DIR")); dir != "" {
		return dir
	}
	candidates := []string{
		filepath.Join("..", "web", "skills"),
		filepath.Join("..", "..", "apps", "web", "skills"),
		filepath.Join("apps", "web", "skills"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

// SkillPackHandler GET /api/agent/skill-pack：把 skills 资源目录打包为 zip 附件；
// 源目录不存在时按 TS notFound 风格返回 404 错误体。
func SkillPackHandler() gin.HandlerFunc {
	return agentSkillPackBody
}

func agentSkillPackBody(c *gin.Context) {
	sourceDir := skillsSourceDir()
	if sourceDir == "" {
		httpx.ErrorJSON(c, http.StatusNotFound, "Skill 资源目录不存在")
		return
	}

	var files []skillPackageFile
	err := filepath.Walk(sourceDir, func(path string, info os.FileInfo, werr error) error {
		if werr != nil || info.IsDir() {
			return werr
		}
		rel, rerr := filepath.Rel(sourceDir, path)
		if rerr != nil {
			return rerr
		}
		content, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		files = append(files, skillPackageFile{
			name:    filepath.ToSlash(rel),
			content: content,
		})
		return nil
	})
	if err != nil || len(files) == 0 {
		httpx.ErrorJSON(c, http.StatusNotFound, "Skill 资源目录不存在")
		return
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, file := range files {
		w, zerr := zw.Create(file.name)
		if zerr != nil {
			httpx.HandleError(c, zerr)
			return
		}
		if _, zerr := w.Write(file.content); zerr != nil {
			httpx.HandleError(c, zerr)
			return
		}
	}
	if err := zw.Close(); err != nil {
		httpx.HandleError(c, err)
		return
	}

	c.Header("Cache-Control", "public, max-age=300")
	c.Header("Content-Disposition", `attachment; filename="petrichor-agent-skills.zip"`)
	c.Data(http.StatusOK, "application/zip", buf.Bytes())
}

type skillPackageFile struct {
	name    string
	content []byte
}
