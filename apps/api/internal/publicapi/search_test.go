package publicapi

import (
	"strings"
	"testing"
)

func searchTestHit(key, resultType string, lexical, semantic float64) *publicSearchHit {
	return &publicSearchHit{
		key: key, resultType: resultType, title: key,
		lexicalScore: lexical, semanticScore: semantic,
		matchReason: "全文匹配",
	}
}

func TestPublicSearchTokenTextBuildsChineseBigrams(t *testing.T) {
	if got := publicSearchTokenText("语义检索 RAG"); got != "语义 义检 检索 rag" {
		t.Fatalf("token text = %q", got)
	}
}

func TestFilterPublicSearchScopeAppliesKnowledgeBaseAndTag(t *testing.T) {
	scope := &publicSearchScope{
		articles: map[int64]*PublicArticleRef{
			1: {ArticleID: 1, UserID: 1, KnowledgeBaseID: 10},
			2: {ArticleID: 2, UserID: 2, KnowledgeBaseID: 20},
		},
		pages: map[int64]*wikiPageRecord{
			3: {id: 3, userID: 1, knowledgeBaseID: 10},
		},
		articleTags: map[int64][]string{1: {"RAG"}, 2: {"Other"}},
	}
	filterPublicSearchScope(scope, 10, "rag")
	if len(scope.articles) != 1 || scope.articles[1] == nil {
		t.Fatalf("article scope = %#v", scope.articles)
	}
	if len(scope.pages) != 0 {
		t.Fatalf("tag 筛选时 Wiki 应被排除: %#v", scope.pages)
	}
	if len(scope.byUser) != 1 {
		t.Fatalf("user scope = %#v", scope.byUser)
	}
}

func TestCombineSearchHitsHybridUsesReciprocalRankFusion(t *testing.T) {
	lexical := []*publicSearchHit{
		searchTestHit("article:1", "article", 9, 0),
		searchTestHit("wiki:2", "wiki", 8, 0),
	}
	semantic := []*publicSearchHit{
		searchTestHit("wiki:2", "wiki", 0, .9),
		searchTestHit("article:3", "article", 0, .8),
	}
	combined := combineSearchHits("hybrid", lexical, semantic)
	if len(combined) != 3 {
		t.Fatalf("combined len = %d, want 3", len(combined))
	}
	if combined[0].key != "wiki:2" {
		t.Fatalf("双路命中结果应排第一，got %s", combined[0].key)
	}
	if combined[0].matchReason != "全文与语义共同匹配" {
		t.Fatalf("match reason = %q", combined[0].matchReason)
	}
}

func TestExtractWikiMatchSnippetCleansMarkdownAndKeepsUTF8Boundaries(t *testing.T) {
	content := "# 标题\n\n![](s4key:uploads/private.webp) 前文 [[entity-mole|小鼹鼠]] 提供 Mole 清理能力，后面还有很多中文。"
	snippet := extractWikiMatchSnippet(content, "Mole", 5)
	if snippet == "" {
		t.Fatal("expected snippet")
	}
	if containsAny(snippet, "s4key:", "[[", "�") {
		t.Fatalf("snippet 未正确清理 Markdown 或截断 UTF-8: %q", snippet)
	}
}

func containsAny(value string, values ...string) bool {
	for _, item := range values {
		if strings.Contains(value, item) {
			return true
		}
	}
	return false
}

func TestCombineSearchHitsKeepsSelectedMode(t *testing.T) {
	lexical := []*publicSearchHit{
		searchTestHit("article:1", "article", 1, 0),
		searchTestHit("article:2", "article", 3, 0),
	}
	result := combineSearchHits("fulltext", lexical, nil)
	if result[0].key != "article:2" || result[1].key != "article:1" {
		t.Fatalf("全文排序错误: %s, %s", result[0].key, result[1].key)
	}
}
