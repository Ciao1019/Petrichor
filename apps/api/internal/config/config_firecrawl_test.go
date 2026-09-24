package config

import "testing"

func TestFirecrawlDefaultsAndValidation(t *testing.T) {
	c, e := normalizeFirecrawl(FirecrawlConfig{})
	if e != nil || c.Enabled || c.MaxBatch != 10 || c.Concurrency != 4 {
		t.Fatal(c, e)
	}
	for _, input := range []FirecrawlConfig{{Enabled: true}, {BaseURL: "https://user:pass@example.com"}, {BaseURL: "file:///tmp/service"}, {DailyLimit: -1}, {Concurrency: 100}} {
		if _, e := normalizeFirecrawl(input); e == nil {
			t.Fatal("无效配置被接受")
		}
	}
	c, e = normalizeFirecrawl(FirecrawlConfig{Enabled: true, BaseURL: "http://firecrawl:3002"})
	if e != nil || c.AIFormats || c.Screenshot {
		t.Fatal("自托管不能默认宣称拥有云能力", c, e)
	}
}
