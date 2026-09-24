package assistantsvc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/config"
)

func TestMCPSessionIsolationDiscoveryAndCall(t *testing.T) {
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	type input struct {
		Query string `json:"query"`
	}
	mcp.AddTool(server, &mcp.Tool{Name: "read"}, func(ctx context.Context, request *mcp.CallToolRequest, args input) (*mcp.CallToolResult, map[string]string, error) {
		return nil, map[string]string{"session": request.Session.ID(), "query": args.Query}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "hidden"}, func(context.Context, *mcp.CallToolRequest, input) (*mcp.CallToolResult, map[string]string, error) {
		return nil, map[string]string{}, nil
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{JSONResponse: true})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("未鉴权")
		}
		handler.ServeHTTP(w, r)
	}))
	defer endpoint.Close()
	cfg := config.AgentMCPServer{Name: "test-isolation", URL: endpoint.URL, Token: "test-secret", ReadTools: []string{"read"}, TimeoutSeconds: 3}
	call := func(user, thread int64) string {
		out, err := withMCPSession(&rt.ToolExecutionContext{Context: context.Background(), UserID: user, ThreadID: thread}, cfg, func(ctx context.Context, s *mcp.ClientSession) (any, error) {
			tools, err := discoverMCPTools(ctx, s, cfg)
			if err != nil {
				return nil, err
			}
			if len(tools) != 1 || tools[0]["name"] != "read" {
				t.Errorf("工具白名单失效: %+v", tools)
			}
			result, err := s.CallTool(ctx, &mcp.CallToolParams{Name: "read", Arguments: map[string]any{"query": "中文"}})
			if err != nil {
				return nil, err
			}
			return result.StructuredContent, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return out.(map[string]any)["session"].(string)
	}
	a := call(90001, 90001)
	if a != call(90001, 90001) {
		t.Fatal("同一对话丢失 MCP 状态")
	}
	if a == call(90002, 90001) || a == call(90001, 90002) {
		t.Fatal("MCP 会话跨用户/对话共享")
	}
	t.Cleanup(func() {
		mcpConnections.Lock()
		defer mcpConnections.Unlock()
		for key, entry := range mcpConnections.entries {
			if entry.session != nil {
				_ = entry.session.Close()
			}
			if entry.timer != nil {
				entry.timer.Stop()
			}
			delete(mcpConnections.entries, key)
		}
	})
}

func TestMCPRejectsRemoteSchemaReferences(t *testing.T) {
	if localSchemaReferences(map[string]any{"properties": map[string]any{"secret": map[string]any{"$ref": "file:///etc/passwd"}}}) {
		t.Fatal("允许访问宿主 schema")
	}
	if !localSchemaReferences(map[string]any{"$ref": "#/$defs/local"}) {
		t.Fatal("拒绝本地引用")
	}
}
