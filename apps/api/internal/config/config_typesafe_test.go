package config

import "testing"

func TestTypeSafeConfig(t *testing.T) {
	c, err := normalizeTypeSafe(TypeSafeConfig{})
	if err != nil || c.Enabled || c.Model != "jev-1.13.0" || c.TimeoutSeconds != 20 || c.MinConfidence != 0.7 || c.TagThreshold != 0.85 {
		t.Fatal("默认配置错误", c, err)
	}
	for _, input := range []TypeSafeConfig{
		{Enabled: true}, {BaseURL: "https://user:secret@example.com"}, {BaseURL: "file:///tmp/client"},
		{BaseURL: "https://example.com?key=secret"}, {TimeoutSeconds: 61}, {MinConfidence: -1}, {TagThreshold: 1.1},
	} {
		if _, err := normalizeTypeSafe(input); err == nil {
			t.Fatal("无效配置被接受")
		}
	}
	cfg, err := LoadFile(writeTestConfig(t, "[database]\nurl='postgres://localhost/test'\n[typesafe]\nenabled=true\napi_key='test-only'\nmin_confidence=0.8\n"))
	if err != nil || !cfg.TypeSafe.Enabled || cfg.TypeSafe.MinConfidence != 0.8 || cfg.TypeSafe.APIKey != "test-only" {
		t.Fatal("TOML 配置未接通", err)
	}
}
