package publicqa

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func TestPublicIDAcceptsNumberAndStringStrictly(t *testing.T) {
	for _, raw := range []string{`12`, `"12"`} {
		var id publicID
		if err := json.Unmarshal([]byte(raw), &id); err != nil || id != 12 {
			t.Fatalf("parse %s: id=%d err=%v", raw, id, err)
		}
	}
	for _, raw := range []string{`"12x"`, `0`, `1e2`, `""`} {
		var id publicID
		if err := json.Unmarshal([]byte(raw), &id); err == nil {
			t.Fatalf("expected %s to be rejected", raw)
		}
	}
}

func TestVisitorIDRequiresUUID(t *testing.T) {
	if !visitorUUIDPattern.MatchString("123e4567-e89b-12d3-a456-426614174000") {
		t.Fatal("valid UUID was rejected")
	}
	for _, invalid := range []string{"visitor", "123", "123e4567-e89b-12d3-a456-42661417400z"} {
		if visitorUUIDPattern.MatchString(invalid) {
			t.Fatalf("invalid visitor id accepted: %q", invalid)
		}
	}
}

func TestPublicMessagesForModelKeepsHistoryAndToolResults(t *testing.T) {
	var messages []publicUIMessage
	raw := `[
		{"role":"user","parts":[{"type":"text","text":"找文章"}]},
		{"role":"assistant","parts":[{"type":"text","text":"找到了"},{"type":"tool-search_public_articles","output":{"items":[{"title":"雨"}]}}]},
		{"role":"user","parts":[{"type":"text","text":"继续"}]}
	]`
	if err := json.Unmarshal([]byte(raw), &messages); err != nil {
		t.Fatal(err)
	}
	converted := publicMessagesForModel(messages)
	if len(converted) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(converted))
	}
	if !strings.Contains(converted[1].Content, "search_public_articles") || !strings.Contains(converted[1].Content, "雨") {
		t.Fatalf("tool result missing: %q", converted[1].Content)
	}
}

func TestSearchPublicArticlesStaysInsideScope(t *testing.T) {
	now := time.Now().UTC()
	scope := publicArticleScope{
		1: {
			ArticleID: 1, ShareCode: "one", Title: "雨天记录",
			Article: &ent.KBArticle{ID: 1, Title: "雨天记录", ContentMd: "空气里有泥土气味", UpdatedAt: now},
			Share:   &ent.KBArticleShare{ID: 1, ArticleID: 1, ShareCode: "one", Enabled: true},
		},
		2: {
			ArticleID: 2, ShareCode: "two", Title: "晴天",
			Article: &ent.KBArticle{ID: 2, Title: "晴天", ContentMd: "阳光", UpdatedAt: now.Add(-time.Hour)},
			Share:   &ent.KBArticleShare{ID: 2, ArticleID: 2, ShareCode: "two", Enabled: true},
		},
	}
	hits := searchPublicArticleItems(scope, "泥土", 8)
	if len(hits) != 1 || hits[0]["articleId"] != "1" || hits[0]["href"] != "/p/one" {
		t.Fatalf("unexpected hits: %#v", hits)
	}
}

func TestExtractPublicMediaReturnsCanonicalStorageReferences(t *testing.T) {
	articleID := "7"
	title := "文章"
	media := extractPublicMedia("![图](s4key:uploads/9/demo.png)\n<a href=\"https://example.com/a.pdf\">附件</a>", &articleID, &title)
	if len(media) != 2 {
		t.Fatalf("expected two media refs, got %#v", media)
	}
	if media[0].Kind != "image" || media[0].Src != "s4key:uploads/9/demo.png" || media[0].SourceArticleID == nil {
		t.Fatalf("unexpected image ref: %#v", media[0])
	}
	if media[1].Kind != "file" {
		t.Fatalf("unexpected file ref: %#v", media[1])
	}
}

func TestPublicQASystemPromptEnforcesPublicBoundary(t *testing.T) {
	prompt := buildPublicQASystemPrompt()
	for _, expected := range []string{"公开分享", "严禁编造", "show_citations", "read_source_article"} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt missing %q", expected)
		}
	}
}
