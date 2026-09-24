package config

import (
	"fmt"
	"net/url"
	"strings"
)

// TypeSafeConfig 是随笔归档推荐的独立服务配置，不占用 CHAT 用途绑定。
type TypeSafeConfig struct {
	Enabled        bool    `toml:"enabled"`
	BaseURL        string  `toml:"base_url"`
	APIKey         string  `toml:"api_key"`
	Model          string  `toml:"model"`
	TimeoutSeconds int     `toml:"timeout_seconds"`
	MinConfidence  float64 `toml:"min_confidence"`
	TagThreshold   float64 `toml:"tag_threshold"`
}

func normalizeTypeSafe(c TypeSafeConfig) (TypeSafeConfig, error) {
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if c.BaseURL == "" {
		c.BaseURL = "https://api.typesafe.ai"
	}
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return c, fmt.Errorf("typesafe.base_url 必须为有效 HTTP(S) 服务地址")
	}
	c.APIKey = strings.TrimSpace(c.APIKey)
	c.Model = strings.TrimSpace(c.Model)
	if c.Model == "" {
		c.Model = "jev-1.13.0"
	}
	if c.Enabled && c.APIKey == "" {
		return c, fmt.Errorf("启用归档推荐必须配置 typesafe.api_key")
	}
	if c.TimeoutSeconds == 0 {
		c.TimeoutSeconds = 20
	}
	if c.MinConfidence == 0 {
		c.MinConfidence = 0.7
	}
	if c.TagThreshold == 0 {
		c.TagThreshold = 0.85
	}
	if c.TimeoutSeconds < 1 || c.TimeoutSeconds > 60 || !(c.MinConfidence > 0 && c.MinConfidence <= 1) || !(c.TagThreshold > 0 && c.TagThreshold <= 1) {
		return c, fmt.Errorf("typesafe 超时须为 1–60 秒，置信度与标签阈值须大于 0 且不超过 1")
	}
	return c, nil
}
