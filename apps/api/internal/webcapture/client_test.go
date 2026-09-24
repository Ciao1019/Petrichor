package webcapture

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"petrichor/api/internal/config"
	"strings"
	"testing"
)

func TestURLPolicy(t *testing.T) {
	for _, u := range []string{"file:///etc/passwd", "http://127.0.0.1/a", "http://10.1.2.3", "http://100.64.0.1", "http://localhost", "https://alice:secret@example.com", "http://[::1]", "http://metadata.google.internal"} {
		if _, e := ParseURL(u); e == nil {
			t.Errorf("应拒绝 %s", u)
		}
	}
	u, e := ParseURL("https://example.com/article?version=1#part")
	if e != nil || u.String() != "https://example.com/article?version=1" {
		t.Fatalf("规范化破坏 URL: %v %v", u, e)
	}
}
func TestFirecrawlWireContract(t *testing.T) {
	cases := []struct {
		name, body string
		status     int
		want       string
	}{
		{"success", `{"success":true,"data":{"markdown":"# 正文\n\n这是一段足够明确的原文。","metadata":{"title":"示例","statusCode":200},"links":["https://example.com/a","javascript:alert(1)","https://example.com/a"],"images":["data:image/png;base64,invalid"],"json":{"title":"笔记","summary":"摘要","takeaways":[],"tags":["重复","重复"],"quotes":[{"text":"这是一段足够明确的原文。"},{"text":"虚构摘录"}]}}}`, 200, ""},
		{"target404", `{"success":true,"data":{"markdown":"Not found","metadata":{"statusCode":404}}}`, 200, "HTTP 404"},
		{"quota", `{"secret":"should never appear"}`, 402, "额度不足"},
		{"invalid", `<html>error</html>`, 200, "有效结果"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v2/scrape" || r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("请求契约不匹配")
				}
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["maxAge"] != float64(0) {
					t.Error("没有指定最新内容")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := Client{Config: config.FirecrawlConfig{BaseURL: server.URL, APIKey: "test-key", TimeoutSeconds: 10}}
			result, e := client.Scrape(context.Background(), "https://93.184.216.34/article", Options{Mode: "read", Engine: "firecrawl", Fresh: true})
			if tc.want != "" {
				if e == nil || !strings.Contains(e.Error(), tc.want) {
					t.Fatalf("got %v", e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if len(result.Links) != 1 || len(result.Assets) != 0 || len(result.Note.Tags) != 1 || result.Note.Quotes[0].Line != 3 || result.Note.Quotes[1].Line != 0 {
				t.Fatalf("返回值未归一化: %+v", result)
			}
		})
	}
}
func TestCostsAndCapabilities(t *testing.T) {
	c := config.FirecrawlConfig{TimeoutSeconds: 120, Screenshot: true, AIFormats: true, Actions: true}
	o := Options{Mode: "quote", Engine: "firecrawl", Focus: "核心观点", Screenshot: true, FullPage: true, MainContent: true, Loading: "scroll"}
	if e := o.Validate(c); e != nil {
		t.Fatal(e)
	}
	b := RequestBody("https://example.com", o, c)
	raw, _ := json.Marshal(b)
	s := string(raw)
	if !strings.Contains(s, `"type":"highlights"`) || strings.Contains(s, `"type":"question"`) || !strings.Contains(s, `"fullPage":true`) {
		t.Fatalf("错误请求: %s", s)
	}
	c.AIFormats = false
	if e := o.Validate(c); e == nil {
		t.Fatal("自托管能力开关被绕过")
	}
	o = Options{Mode: "design"}
	if e := o.Validate(c); e == nil {
		t.Fatal("已移除的用途仍可请求")
	}
}
func TestNoteOutputBounds(t *testing.T) {
	n := NormalizeNote(Note{Title: strings.Repeat("字", 300), Summary: strings.Repeat("字", 3000), Quotes: []Quote{{Text: "原句", Line: 900}, {Text: "捏造", Line: 1}}}, "标题\n原句")
	if len([]rune(n.Title)) != 200 || len([]rune(n.Summary)) != 2000 || n.Quotes[0].Line != 2 || n.Quotes[1].Line != 0 {
		t.Fatal(n)
	}
}
