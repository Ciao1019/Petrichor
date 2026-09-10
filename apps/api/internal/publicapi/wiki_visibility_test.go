package publicapi

import (
	"testing"
)

func TestPublicWikiReferencesDoNotExposePrivateTitlesOrKeys(t *testing.T) {
	targets := publicWikiTargets{publicWikiPageHref(1, "concept/公开"): true}
	for _, test := range []struct{ name, content, want string }{
		{"公开别名", "见 [[concept/公开|公开概念]]", "见 [[concept/公开|公开概念]]"},
		{"私有别名", "见 [[secret-key|未公开计划]]", "见 （未公开知识页）"},
		{"无别名", "[[secret-key]]", "（未公开知识页）"},
		{"私有片段链接", "[未公开计划](#wiki-page=secret-key)", "（未公开知识页）"},
		{"跨库同名链接", "[未公开计划](/wiki/2/concept%2F%E5%85%AC%E5%BC%80)", "（未公开知识页）"},
		{"公开路由", "[公开概念](/wiki/1/concept%2F%E5%85%AC%E5%BC%80)", "[公开概念](/wiki/1/concept%2F%E5%85%AC%E5%BC%80)"},
		{"普通链接", "[文档](https://example.com/docs)", "[文档](https://example.com/docs)"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := sanitizePublicWikiReferences(test.content, 1, targets); got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

func TestPublicWikiSummaryUsesSanitizedContent(t *testing.T) {
	page := &wikiPageRecord{knowledgeBaseID: 1, title: "公开文章", contentMd: "# 公开文章\n\n[[private-key|私人标题]]"}
	sanitizePublicWikiPage(page, publicWikiTargets{})
	if got := toWikiQaCard(page)["summary"]; got != "公开文章 （未公开知识页）" {
		t.Fatalf("派生摘要未清理私有引用: %q", got)
	}
}
