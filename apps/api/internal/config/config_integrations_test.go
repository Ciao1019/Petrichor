package config

import "testing"

func TestLoadAgentIntegrations(t *testing.T) {
	path := writeTestConfig(t, `
[database]
url="postgres://localhost/petrichor"
[agent.integrations.rerank]
enabled=true
url="https://example.com/v1/rerank"
model="test"
[[agent.integrations.mcp]]
name="docs"
url="http://127.0.0.1:8931/mcp"
read_tools=["search"]
`)
	cfg, err := LoadFile(path)
	if err != nil || !cfg.Agent.Integrations.Rerank.Enabled || len(cfg.Agent.Integrations.MCP) != 1 {
		t.Fatalf("配置未接线: %v", err)
	}
}

func TestIntegrationConfigurationBoundaries(t *testing.T) {
	valid := AgentIntegrationsConfig{MCP: []AgentMCPServer{{Name: "docs", URL: "https://example.com/mcp", ReadTools: []string{"search"}}}}
	normalized, err := normalizeIntegrations(valid)
	if err != nil || normalized.MCP[0].TimeoutSeconds != 30 {
		t.Fatalf("%+v %v", normalized, err)
	}
	for _, c := range []AgentIntegrationsConfig{
		{MCP: []AgentMCPServer{{Name: "docs", URL: "file:///secret", ReadTools: []string{"search"}}}},
		{MCP: []AgentMCPServer{{Name: "docs", URL: "https://example.com/mcp", ReadTools: []string{"delete"}, WriteTools: []string{"delete"}}}},
		{MCP: []AgentMCPServer{{Name: "docs", URL: "https://example.com/mcp"}}},
		{Sandbox: AgentSandboxConfig{Enabled: true, URL: "http://sandbox/execute", Token: "short"}},
		{Rerank: AgentRerankConfig{Enabled: true, URL: "https://example.com/rerank"}},
	} {
		if _, err := normalizeIntegrations(c); err == nil {
			t.Fatal("接受了不安全/不完整配置")
		}
	}
}
