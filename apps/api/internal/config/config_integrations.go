package config

import (
	"fmt"
	"net/url"
	"regexp"
)

// 外部服务只由管理员配置。模型只能选择服务名，不能提供地址或凭据。
type AgentIntegrationsConfig struct {
	MCP     []AgentMCPServer   `toml:"mcp"`
	Rerank  AgentRerankConfig  `toml:"rerank"`
	Sandbox AgentSandboxConfig `toml:"sandbox"`
}

type AgentMCPServer struct {
	Name           string   `toml:"name"`
	URL            string   `toml:"url"`
	Token          string   `toml:"token"`
	ReadTools      []string `toml:"read_tools"`
	WriteTools     []string `toml:"write_tools"`
	AllowUsers     bool     `toml:"allow_users"`
	TimeoutSeconds int      `toml:"timeout_seconds"`
}

type AgentRerankConfig struct {
	Enabled        bool   `toml:"enabled"`
	URL            string `toml:"url"`
	APIKey         string `toml:"api_key"`
	Model          string `toml:"model"`
	TimeoutSeconds int    `toml:"timeout_seconds"`
}

type AgentSandboxConfig struct {
	Enabled        bool   `toml:"enabled"`
	URL            string `toml:"url"`
	Token          string `toml:"token"`
	TimeoutSeconds int    `toml:"timeout_seconds"`
	AllowUsers     bool   `toml:"allow_users"`
}

var integrationName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,47}$`)

func validateIntegrationURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("外部服务地址必须是无用户信息、查询参数与片段的 HTTP(S) URL")
	}
	return nil
}

func normalizeIntegrations(c AgentIntegrationsConfig) (AgentIntegrationsConfig, error) {
	names := map[string]bool{}
	if len(c.MCP) > 16 {
		return c, fmt.Errorf("最多配置 16 个 MCP 服务")
	}
	for i := range c.MCP {
		s := &c.MCP[i]
		if !integrationName.MatchString(s.Name) || names[s.Name] {
			return c, fmt.Errorf("MCP 服务名无效或重复")
		}
		names[s.Name] = true
		if err := validateIntegrationURL(s.URL); err != nil {
			return c, err
		}
		if s.TimeoutSeconds == 0 {
			s.TimeoutSeconds = 30
		}
		if s.TimeoutSeconds < 1 || s.TimeoutSeconds > 120 {
			return c, fmt.Errorf("MCP 超时须为 1–120 秒")
		}
		seen := map[string]bool{}
		for _, tool := range append(append([]string{}, s.ReadTools...), s.WriteTools...) {
			if tool == "" || len(tool) > 128 || seen[tool] {
				return c, fmt.Errorf("MCP 工具白名单有空值或重复")
			}
			seen[tool] = true
		}
		if len(seen) == 0 || len(seen) > 128 {
			return c, fmt.Errorf("MCP 必须显式配置 1–128 个允许的工具")
		}
	}
	if c.Rerank.TimeoutSeconds == 0 {
		c.Rerank.TimeoutSeconds = 8
	}
	if c.Rerank.Enabled {
		if err := validateIntegrationURL(c.Rerank.URL); err != nil {
			return c, err
		}
		if c.Rerank.Model == "" || c.Rerank.TimeoutSeconds < 1 || c.Rerank.TimeoutSeconds > 30 {
			return c, fmt.Errorf("重排须配置模型及 1–30 秒超时")
		}
	}
	if c.Sandbox.Enabled {
		if err := validateIntegrationURL(c.Sandbox.URL); err != nil {
			return c, err
		}
		if len(c.Sandbox.Token) < 32 {
			return c, fmt.Errorf("沙箱访问 token 至少 32 字符")
		}
	}
	if c.Sandbox.TimeoutSeconds == 0 {
		c.Sandbox.TimeoutSeconds = 20
	}
	if c.Sandbox.TimeoutSeconds < 1 || c.Sandbox.TimeoutSeconds > 60 {
		return c, fmt.Errorf("沙箱超时须为 1–60 秒")
	}
	return c, nil
}
