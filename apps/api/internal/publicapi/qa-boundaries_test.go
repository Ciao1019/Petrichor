package publicapi

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// mockPublicQaSearch 替换召回后端，测试结束后恢复。
func mockPublicQaSearch(t *testing.T, backend qaSearchBackend) {
	t.Helper()
	old := publicQaSearchBackend
	t.Cleanup(func() { publicQaSearchBackend = old })
	publicQaSearchBackend = backend
}

func TestPublicQaUnifiedSearchReturnsArticlesAndWikiTogether(t *testing.T) {
	mockPublicQaSearch(t, qaSearchBackend{
		lexicalArticle: func(context.Context, string, *publicSearchScope, int) ([]*publicSearchHit, error) {
			return []*publicSearchHit{{key: "article:1", resultType: "article", articleID: 1, title: "原文", lexicalScore: 2}}, nil
		},
		lexicalWiki: func(context.Context, string, *publicSearchScope, int) ([]*publicSearchHit, error) {
			return []*publicSearchHit{{key: "wiki:2", resultType: "wiki", wikiPageID: 2, title: "概念", lexicalScore: 1}}, nil
		},
		semantic: func(_ context.Context, _ *publicSearchScope, _, kind string, _ int) ([]*publicSearchHit, bool, string, error) {
			if kind != "all" {
				t.Errorf("统一入口只检索了 %s", kind)
			}
			return nil, false, "", nil
		},
	})
	scope := &PublicKnowledgeScope{search: &publicSearchScope{
		articles: map[int64]*PublicArticleRef{1: {ArticleID: 1, KnowledgeBaseID: 3, ShareCode: "source"}},
		pages:    map[int64]*wikiPageRecord{2: {id: 2, knowledgeBaseID: 3, pageKey: "concept"}},
	}}
	hits, stats, err := scope.Search(context.Background(), "问题", "all", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[0].Type != "article" || hits[1].Type != "wiki" {
		t.Fatalf("原文与 Wiki 未合并: %+v", hits)
	}
	if hits[0].ArticleID != 1 || hits[0].Href != "/p/source" || hits[1].PageKey != "concept" || hits[1].KnowledgeBaseID != 3 {
		t.Fatalf("缺少深读标识或公开链接: %+v", hits)
	}
	if stats.Strategy != "fulltext" || stats.LexicalArticle != 1 || stats.LexicalWiki != 1 {
		t.Fatalf("召回统计错误: %+v", stats)
	}
}

func TestPublicQaSearchScopesAndFusesEvidence(t *testing.T) {
	semanticHits := []*publicSearchHit{
		{key: "article:2", resultType: "article", articleID: 2, semanticScore: .9, href: "https://invalid.example"},
		{key: "article:999", resultType: "article", articleID: 999, semanticScore: .8},
	}
	mockPublicQaSearch(t, qaSearchBackend{
		lexicalArticle: func(context.Context, string, *publicSearchScope, int) ([]*publicSearchHit, error) {
			return []*publicSearchHit{
				{key: "article:1", resultType: "article", articleID: 1, lexicalScore: 9},
				{key: "article:2", resultType: "article", articleID: 2, lexicalScore: 5},
			}, nil
		},
		semantic: func(context.Context, *publicSearchScope, string, string, int) ([]*publicSearchHit, bool, string, error) {
			return semanticHits, true, "", nil
		},
	})
	scope := &publicSearchScope{articles: map[int64]*PublicArticleRef{
		1: {ArticleID: 1, ShareCode: "one"}, 2: {ArticleID: 2, ShareCode: "two"},
	}}
	hits, strategy, stats, err := searchPublicQaInScope(context.Background(), scope, "问题", "article", 8)
	if err != nil || strategy != "hybrid" || len(hits) != 2 || hits[0].articleID != 2 || hits[0].href != "/p/two" {
		t.Fatalf("混合召回或公开边界错误: strategy=%s hits=%+v err=%v", strategy, hits, err)
	}
	if stats.semantic != 2 || stats.lexicalArticle != 2 {
		t.Fatalf("召回统计错误: %+v", stats)
	}
	publicQaSearchBackend.semantic = func(context.Context, *publicSearchScope, string, string, int) ([]*publicSearchHit, bool, string, error) {
		return nil, false, "", errors.New("embedding unavailable")
	}
	hits, strategy, _, err = searchPublicQaInScope(context.Background(), scope, "问题", "article", 1)
	if err != nil || strategy != "fulltext" || len(hits) != 1 || hits[0].articleID != 1 {
		t.Fatalf("全文回退失败: strategy=%s hits=%+v err=%v", strategy, hits, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := searchPublicQaInScope(ctx, scope, "问题", "article", 8); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消未传递: %v", err)
	}
}

func TestPublicQaSearchWikiUsesCanonicalIdentity(t *testing.T) {
	mockPublicQaSearch(t, qaSearchBackend{
		lexicalWiki: func(context.Context, string, *publicSearchScope, int) ([]*publicSearchHit, error) {
			return []*publicSearchHit{
				{key: "wiki:8", resultType: "wiki", wikiPageID: 8, knowledgeBaseID: 99, pageKey: "wrong", snippet: "公开知识 [[private-page|私有页面]]", lexicalScore: 2},
				{key: "wiki:9", resultType: "wiki", wikiPageID: 9, lexicalScore: 1},
			}, nil
		},
		semantic: func(context.Context, *publicSearchScope, string, string, int) ([]*publicSearchHit, bool, string, error) {
			return nil, false, "", nil
		},
	})
	scope := &publicSearchScope{pages: map[int64]*wikiPageRecord{8: {id: 8, knowledgeBaseID: 3, pageKey: "concept-public"}}}
	hits, _, _, err := searchPublicQaInScope(context.Background(), scope, "知识", "wiki", 8)
	if err != nil || len(hits) != 1 || hits[0].pageKey != "concept-public" || hits[0].knowledgeBaseID != 3 || hits[0].href != publicWikiPageHref(3, "concept-public") {
		t.Fatalf("Wiki 来源未规范化: %+v %v", hits, err)
	}
	if strings.Contains(hits[0].snippet, "private-page") {
		t.Fatalf("私有 Wiki 引用未过滤: %s", hits[0].snippet)
	}
}

// 限定知识库后，范围外的文章与 Wiki 都不可见。
func TestPublicKnowledgeScopeFiltersKnowledgeBase(t *testing.T) {
	search := &publicSearchScope{
		articles: map[int64]*PublicArticleRef{
			1: {ArticleID: 1, KnowledgeBaseID: 3, UserID: 1, ShareCode: "a"},
			2: {ArticleID: 2, KnowledgeBaseID: 4, UserID: 1, ShareCode: "b"},
		},
		pages:             map[int64]*wikiPageRecord{5: {id: 5, knowledgeBaseID: 4, pageKey: "p"}},
		knowledgeBaseName: map[int64]string{3: "三号库", 4: "四号库"},
	}
	all := &PublicKnowledgeScope{search: search}
	if bases := all.KnowledgeBases(); len(bases) != 2 || bases[0].Name != "三号库" || bases[1].WikiPageCount != 1 {
		t.Fatalf("公开知识库列表错误: %+v", bases)
	}
	filterPublicSearchScope(search, 3, "")
	scoped := &PublicKnowledgeScope{search: search}
	if scoped.Article(2) != nil || len(scoped.WikiPages()) != 0 || len(scoped.KnowledgeBases()) != 1 {
		t.Fatal("限定知识库后仍能看到范围外资料")
	}
	if _, err := requirePublicQaArticle(search.articles, 2); err == nil {
		t.Fatal("范围外文章仍可读取")
	}
}
