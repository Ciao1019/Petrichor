package agent

import (
	"strings"

	"github.com/gin-gonic/gin"
)

func agentRequestBaseURL(c *gin.Context) string {
	proto := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-Proto"), ",")[0])
	if proto == "" {
		if c.Request.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := strings.TrimSpace(strings.Split(c.GetHeader("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = c.Request.Host
	}
	return strings.TrimRight(proto+"://"+host, "/")
}

func agentEndpointMap() gin.H {
	return gin.H{
		"capabilities": "/api/agent/capabilities", "manifest": "/api/agent/manifest",
		"knowledgeBaseList": "/api/agent/knowledge-base/list", "knowledgeBaseTree": "/api/agent/knowledge-base/tree",
		"folderCreate": "/api/agent/folder/create", "articleCreate": "/api/agent/article/create",
		"articleUpdate": "/api/agent/article/update", "articleDelete": "/api/agent/article/delete",
		"articleList": "/api/agent/article/list", "articleMove": "/api/agent/article/move",
		"articleShareCreate": "/api/agent/article/share/create", "articleShareRevoke": "/api/agent/article/share/revoke",
		"articleShareInfo": "/api/agent/article/share/info", "articleSummaryGenerate": "/api/agent/article/summary/generate",
		"articleMindmapGenerate": "/api/agent/article/mindmap/generate", "documentSearch": "/api/agent/document/search",
		"documentView": "/api/agent/document/view", "documentQa": "/api/agent/document/qa",
		"wikiPageList": "/api/agent/wiki/page/list", "wikiPageDetail": "/api/agent/wiki/page/detail",
		"wikiLint": "/api/agent/wiki/lint", "wikiIngest": "/api/agent/wiki/ingest",
		"legacySkill": "/api/agent/skill", "skillPack": "/api/agent/skill-pack",
	}
}

func buildAgentMCPInfo(baseURL string) gin.H {
	return gin.H{
		"endpoint": strings.TrimRight(baseURL, "/") + "/api/mcp", "transport": "streamable-http",
		"auth": gin.H{"type": "bearer", "header": "Authorization: Bearer <apiKey>"},
	}
}

func buildAgentManifest(baseURL string) gin.H {
	baseURL = strings.TrimRight(baseURL, "/")
	return gin.H{
		"name": "Petrichor Agent API", "version": "2026-06-08", "baseUrl": baseURL,
		"mcp":  buildAgentMCPInfo(baseURL),
		"auth": gin.H{"type": "bearer", "env": "PETRICHOR_API_KEY", "header": "Authorization: Bearer <apiKey>"},
		"env":  gin.H{"PETRICHOR_BASE_URL": baseURL, "PETRICHOR_API_KEY": "ptc_live_xxx"},
		"scopes": gin.H{
			"article:write":  []string{"article.create", "article.update", "article.move", "folder.create"},
			"article:delete": []string{"article.delete"},
			"doc:read":       []string{"knowledge-base.list", "knowledge-base.tree", "article.list", "document.search", "document.view"},
			"qa:read":        []string{"document.qa"}, "share:write": []string{"article.share.create", "article.share.revoke", "article.share.info"},
			"ai:write":  []string{"article.summary.generate", "article.mindmap.generate"},
			"wiki:read": []string{"wiki.page.list", "wiki.page.detail", "wiki.lint"}, "wiki:write": []string{"wiki.ingest"},
		},
		"endpoints": agentEndpointMap(),
	}
}
