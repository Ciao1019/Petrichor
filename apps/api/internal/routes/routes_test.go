package routes

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPublicFeedRootRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterPublicFeeds(router)
	routes := map[string]struct{}{}
	for _, route := range router.Routes() {
		routes[route.Method+" "+route.Path] = struct{}{}
	}
	for _, key := range []string{"GET /rss.xml", "HEAD /rss.xml", "GET /atom.xml", "HEAD /atom.xml"} {
		if _, ok := routes[key]; !ok {
			t.Fatalf("public feed route missing: %s", key)
		}
	}
}

func TestRouteRegistryHasNoDuplicatesAndKeepsCriticalContracts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	api := engine.Group("/api")
	RegisterPublic(api)
	RegisterAuth(api)
	RegisterNotification(api)
	RegisterDashboard(api)
	RegisterKB(api)
	RegisterDocLibrary(api)
	RegisterAdmin(api)
	RegisterUpload(api)
	RegisterAI(api)
	RegisterAssistant(api)
	RegisterAgent(api)

	routes := engine.Routes()
	if len(routes) < 200 {
		t.Fatalf("registered routes = %d, want at least 200", len(routes))
	}
	seen := make(map[string]struct{}, len(routes))
	for _, route := range routes {
		key := route.Method + " " + route.Path
		if _, exists := seen[key]; exists {
			t.Fatalf("duplicate route: %s", key)
		}
		seen[key] = struct{}{}
	}

	critical := []string{
		"GET /api/public/search",
		"GET /api/public/wiki/knowledge-bases",
		"GET /api/public/wiki/pages",
		"GET /api/public/wiki/graph",
		"GET /api/public/feed/rss.xml",
		"HEAD /api/public/feed/rss.xml",
		"GET /api/public/feed/atom.xml",
		"HEAD /api/public/feed/atom.xml",
		"POST /api/auth/setup",
		"POST /api/auth/login",
		"GET /api/auth/me",
		"POST /api/kb/wiki/export",
		"GET /api/admin/runtime/metrics",
		"GET /api/admin/runtime/dead-letters",
		"POST /api/admin/runtime/dead-letters/replay",
		"POST /api/assistant/chat",
		"POST /api/mcp",
		"PUT /api/upload/local/*objectKey",
	}
	for _, key := range critical {
		if _, exists := seen[key]; !exists {
			t.Error(fmt.Sprintf("critical route missing: %s", key))
		}
	}

	for key := range seen {
		if key == "GET /api/public/site-graph" || key == "POST /api/public/site-graph" ||
			strings.Contains(key, " /api/admin/site-graph") {
			t.Errorf("removed route is still registered: %s", key)
		}
	}
}
