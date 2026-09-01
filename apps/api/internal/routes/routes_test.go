package routes

import (
	"fmt"
	"testing"

	"github.com/gin-gonic/gin"
)

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
}
