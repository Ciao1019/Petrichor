// Package webcapture 封装 Firecrawl v2 与公共网络访问，不依赖 HTTP 路由或 Agent。
package webcapture

import (
	"petrichor/api/internal/config"
	"petrichor/api/internal/httpx"
	"strings"
	"unicode/utf8"
)

const MaxMarkdownBytes = 2 << 20

type Options struct {
	Mode        string   `json:"mode"`
	Engine      string   `json:"engine"`
	Focus       string   `json:"focus"`
	Language    string   `json:"language"`
	Screenshot  bool     `json:"screenshot"`
	FullPage    bool     `json:"fullPage"`
	MainContent bool     `json:"mainContent"`
	Fresh       bool     `json:"fresh"`
	Mobile      bool     `json:"mobile"`
	Loading     string   `json:"loading"`
	IncludeTags []string `json:"includeTags"`
	ExcludeTags []string `json:"excludeTags"`
}

func (o *Options) Validate(c config.FirecrawlConfig) error {
	if o.Mode == "" {
		o.Mode = "read"
	}
	if o.Engine == "" {
		o.Engine = "model"
	}
	if o.Language == "" {
		o.Language = "zh"
	}
	if o.Loading == "" {
		o.Loading = "auto"
	}
	if o.Mode != "read" && o.Mode != "quote" && o.Mode != "assets" {
		return httpx.BadRequest("未知采集用途")
	}
	if o.Mode == "assets" {
		o.Engine = "none"
	}
	if o.Engine != "model" && o.Engine != "firecrawl" && o.Engine != "none" {
		return httpx.BadRequest("未知整理方式")
	}
	if o.Language != "zh" && o.Language != "original" {
		return httpx.BadRequest("整理语言无效")
	}
	if utf8.RuneCountInString(o.Focus) > 500 {
		return httpx.BadRequest("关注的问题不能超过 500 字")
	}
	if o.Mode == "quote" && strings.TrimSpace(o.Focus) == "" {
		return httpx.BadRequest("请填写希望摘录的主题或问题")
	}
	if o.Loading != "auto" && o.Loading != "wait" && o.Loading != "scroll" {
		return httpx.BadRequest("页面加载方式无效")
	}
	if o.Screenshot && !c.Screenshot {
		return httpx.BadRequest("当前采集服务未开启截图能力")
	}
	if o.Loading == "scroll" && !c.Actions {
		return httpx.BadRequest("当前采集服务未开启页面动作")
	}
	if o.Engine == "firecrawl" && !c.AIFormats {
		return httpx.BadRequest("当前采集服务未开启内置 AI 提取")
	}
	for _, tags := range [][]string{o.IncludeTags, o.ExcludeTags} {
		if len(tags) > 10 {
			return httpx.BadRequest("最多指定 10 个内容选择器")
		}
		for _, s := range tags {
			if len(s) > 200 {
				return httpx.BadRequest("内容选择器过长")
			}
		}
	}
	return nil
}

type Quote struct {
	Text string `json:"text"`
	Line int    `json:"line"`
}
type Note struct {
	Title     string   `json:"title"`
	Summary   string   `json:"summary"`
	Takeaways []string `json:"takeaways"`
	Tags      []string `json:"tags"`
	Quotes    []Quote  `json:"quotes"`
}
type Asset struct {
	ID        string `json:"id"`
	SourceURL string `json:"sourceUrl"`
	Key       string `json:"key,omitempty"`
	URL       string `json:"url,omitempty"`
	Kind      string `json:"kind"`
	Error     string `json:"error,omitempty"`
}
type Result struct {
	Markdown     string   `json:"markdown"`
	Note         Note     `json:"note"`
	Assets       []Asset  `json:"assets"`
	Links        []string `json:"links"`
	Warnings     []string `json:"warnings"`
	URL          string   `json:"url"`
	FinalURL     string   `json:"finalUrl"`
	Language     string   `json:"language"`
	FetchedAt    string   `json:"fetchedAt"`
	CachedAt     string   `json:"cachedAt,omitempty"`
	StatusCode   int      `json:"statusCode"`
	Credits      *float64 `json:"credits,omitempty"`
	InputTokens  int      `json:"inputTokens"`
	OutputTokens int      `json:"outputTokens"`
	MarkdownKey  string   `json:"markdownKey,omitempty"`
	Hash         string   `json:"hash"`
	Diff         string   `json:"diff,omitempty"`
	Change       string   `json:"change,omitempty"`
}
