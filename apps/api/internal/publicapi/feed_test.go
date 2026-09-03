package publicapi

import (
	"bytes"
	"encoding/xml"
	"net/http"
	"strings"
	"testing"
	"time"
)

func testFeedArticles() []publicFeedArticle {
	return []publicFeedArticle{{
		id:        1,
		title:     "RAG 与 <Wiki>",
		summary:   "公开摘要 & 来源",
		contentMd: "# 完整正文\n\n只允许公开内容。",
		href:      "/p/public-code",
		createdAt: time.Date(2026, 8, 20, 8, 0, 0, 0, time.UTC),
		updatedAt: time.Date(2026, 8, 21, 9, 30, 0, 0, time.UTC),
		tags:      []string{"RAG", "Wiki"},
	}}
}

func TestFeedConditionalRequestValidation(t *testing.T) {
	lastModified := time.Date(2026, 8, 21, 9, 30, 0, 0, time.UTC)
	if !shouldReturnFeedNotModified(`"other", W/"etag"`, "", `"etag"`, lastModified) {
		t.Fatal("ETag 列表中的弱校验器应返回 not modified")
	}
	if !shouldReturnFeedNotModified("", lastModified.Format(http.TimeFormat), `"etag"`, lastModified) {
		t.Fatal("matching Last-Modified should return not modified")
	}
	if shouldReturnFeedNotModified(`"other"`, lastModified.Add(-time.Minute).Format(http.TimeFormat), `"etag"`, lastModified) {
		t.Fatal("stale validators must not return not modified")
	}
}

func TestRenderRSSFeedProducesValidXML(t *testing.T) {
	body, err := renderRSSFeed(testFeedArticles())
	if err != nil {
		t.Fatal(err)
	}
	var parsed rssDocument
	if err := xml.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("RSS 不是合法 XML: %v\n%s", err, body)
	}
	if parsed.Version != "2.0" || len(parsed.Channel.Items) != 1 {
		t.Fatalf("unexpected RSS: %#v", parsed)
	}
	item := parsed.Channel.Items[0]
	if item.Title != "RAG 与 <Wiki>" || item.Description != "公开摘要 & 来源" {
		t.Fatalf("RSS 字段未正确转义还原: %#v", item)
	}
	if !strings.HasSuffix(item.Link, "/p/public-code") || len(item.Categories) != 2 {
		t.Fatalf("RSS 链接或分类错误: %#v", item)
	}
}

func TestRenderAtomFeedIncludesSummaryAndDiscoveryLink(t *testing.T) {
	body, err := renderAtomFeed(testFeedArticles())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`xmlns="http://www.w3.org/2005/Atom"`)) {
		t.Fatalf("Atom 缺少命名空间: %s", body)
	}
	var parsed atomDocument
	if err := xml.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("Atom 不是合法 XML: %v\n%s", err, body)
	}
	if len(parsed.Entries) != 1 || parsed.Entries[0].Summary.Value != "公开摘要 & 来源" {
		t.Fatalf("Atom 未包含公开摘要: %#v", parsed.Entries)
	}
	if bytes.Contains(body, []byte("完整正文")) {
		t.Fatalf("Atom 不应暴露完整 Markdown: %s", body)
	}
	selfFound := false
	for _, link := range parsed.Links {
		if link.Rel == "self" && strings.HasSuffix(link.Href, "/atom.xml") {
			selfFound = true
		}
	}
	if !selfFound {
		t.Fatal("Atom 缺少 rel=self 订阅发现链接")
	}
}
