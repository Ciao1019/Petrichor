package config

import (
	"fmt"
	"net/url"
	"strings"
)

// FirecrawlConfig 只在服务端持有密钥；自托管能力需由管理员显式开启。
type FirecrawlConfig struct {
	Enabled            bool   `toml:"enabled"`
	BaseURL            string `toml:"base_url"`
	APIKey             string `toml:"api_key"`
	Screenshot         bool   `toml:"screenshot"`
	Actions            bool   `toml:"actions"`
	AIFormats          bool   `toml:"ai_formats"`
	TimeoutSeconds     int    `toml:"timeout_seconds"`
	Concurrency        int    `toml:"concurrency"`
	PerUserConcurrency int    `toml:"per_user_concurrency"`
	DailyLimit         int    `toml:"daily_limit"`
	MaxBatch           int    `toml:"max_batch"`
}

func normalizeFirecrawl(c FirecrawlConfig) (FirecrawlConfig, error) {
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if c.BaseURL == "" {
		c.BaseURL = "https://api.firecrawl.dev"
	}
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return c, fmt.Errorf("firecrawl.base_url 必须为有效 HTTP(S) 服务地址")
	}
	c.APIKey = strings.TrimSpace(c.APIKey)
	if c.Enabled && u.Hostname() == "api.firecrawl.dev" && c.APIKey == "" {
		return c, fmt.Errorf("启用 Firecrawl Cloud 必须配置 firecrawl.api_key")
	}
	defaults := []struct {
		p          *int
		value, max int
	}{{&c.TimeoutSeconds, 120, 300}, {&c.Concurrency, 4, 32}, {&c.PerUserConcurrency, 2, 8}, {&c.DailyLimit, 50, 10000}, {&c.MaxBatch, 10, 50}}
	for _, v := range defaults {
		if *v.p == 0 {
			*v.p = v.value
		}
		if *v.p < 1 || *v.p > v.max {
			return c, fmt.Errorf("firecrawl 超时、并发或额度超出允许范围")
		}
	}
	return c, nil
}
