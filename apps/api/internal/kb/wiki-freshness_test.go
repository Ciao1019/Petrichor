package kb

import (
	"strconv"
	"testing"
	"time"
)

// newSourcePage 造一个带编译指纹的 source 页面。
func newSourcePage(articleID int64, sourceHash string, updatedAt time.Time) WikiPageRow {
	frontmatter := `{"generatedBy":"article-knowledge-build","buildVersion":` +
		strconv.Itoa(ArticleKnowledgeBuildVersion) + `,"chunkAlgorithmVersion":` +
		strconv.Itoa(ChunkAlgorithmVersion) + `,"sourceHash":"` + sourceHash + `"}`
	return WikiPageRow{
		ID: articleID * 10, KnowledgeBaseID: 1, Kind: "source",
		PageKey: buildArticleWikiSourcePageKey(articleID), Title: "源文档",
		FrontmatterJson: &frontmatter, UpdatedAt: updatedAt,
	}
}

func TestEvaluateWikiFreshnessFlagsChangedSource(t *testing.T) {
	compiledAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	editedAt := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	article := &ArticleRow{ID: 1, Title: "标题", ContentMd: "改过的正文", UpdatedAt: editedAt}

	// source 页面存的是旧内容的指纹。
	sourcePage := newSourcePage(1, sha256Hex("标题\n原始正文"), compiledAt)
	conceptFrontmatter := `{"buildVersion":` + strconv.Itoa(ArticleKnowledgeBuildVersion) + `}`
	conceptPage := WikiPageRow{
		ID: 99, KnowledgeBaseID: 1, Kind: "concept", PageKey: "concept-x", Title: "概念 X",
		FrontmatterJson: &conceptFrontmatter, UpdatedAt: compiledAt,
	}
	pages := []WikiPageRow{sourcePage, conceptPage}
	refsByPage := map[int64][]SourceRefRow{
		sourcePage.ID:  {{PageID: sourcePage.ID, ArticleID: 1}},
		conceptPage.ID: {{PageID: conceptPage.ID, ArticleID: 1}},
	}
	articles := map[int64]*ArticleRow{1: article}

	freshness := evaluateWikiFreshness(pages, refsByPage, articles)
	if freshness.StalePageCount != 2 {
		t.Fatalf("StalePageCount = %d，源文档和派生概念页都应失效", freshness.StalePageCount)
	}
	for _, pageID := range []int64{sourcePage.ID, conceptPage.ID} {
		reasons := freshness.ReasonsByPage[pageID]
		if len(reasons) != 1 || reasons[0].Code != wikiIssueStaleSource {
			t.Fatalf("page %d 的原因 = %#v，期望单条 stale_source", pageID, reasons)
		}
		if reasons[0].StaleSince == nil || !reasons[0].StaleSince.Equal(editedAt) {
			t.Fatalf("page %d 的 StaleSince = %v，期望源文档更新时间", pageID, reasons[0].StaleSince)
		}
	}
}

func TestEvaluateWikiFreshnessTrustsFingerprintOverTimestamp(t *testing.T) {
	compiledAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	// 文章更新时间晚于页面，但正文指纹没变（例如只改了标签）——不该判定失效。
	article := &ArticleRow{
		ID: 1, Title: "标题", ContentMd: "正文",
		UpdatedAt: time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC),
	}
	sourcePage := newSourcePage(1, articleFingerprint(article), compiledAt)
	pages := []WikiPageRow{sourcePage}
	refsByPage := map[int64][]SourceRefRow{sourcePage.ID: {{PageID: sourcePage.ID, ArticleID: 1}}}

	freshness := evaluateWikiFreshness(pages, refsByPage, map[int64]*ArticleRow{1: article})
	if freshness.StalePageCount != 0 {
		t.Fatalf("StalePageCount = %d，指纹一致时不应判定失效：%#v",
			freshness.StalePageCount, freshness.ReasonsByPage)
	}
}

func TestEvaluateWikiFreshnessFallsBackToTimestampWithoutSourcePage(t *testing.T) {
	compiledAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	editedAt := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	frontmatter := `{"buildVersion":` + strconv.Itoa(ArticleKnowledgeBuildVersion) + `}`
	page := WikiPageRow{
		ID: 5, KnowledgeBaseID: 1, Kind: "concept", PageKey: "concept-y", Title: "概念 Y",
		FrontmatterJson: &frontmatter, UpdatedAt: compiledAt,
	}
	refsByPage := map[int64][]SourceRefRow{page.ID: {{PageID: page.ID, ArticleID: 7}}}
	articles := map[int64]*ArticleRow{7: {ID: 7, Title: "标题", ContentMd: "正文", UpdatedAt: editedAt}}

	freshness := evaluateWikiFreshness([]WikiPageRow{page}, refsByPage, articles)
	reasons := freshness.ReasonsByPage[page.ID]
	if len(reasons) != 1 || reasons[0].Code != wikiIssueStaleSource {
		t.Fatalf("原因 = %#v，缺少 source 页面时应退回时间比较", reasons)
	}

	// 文章比页面旧则不算失效。
	articles[7].UpdatedAt = compiledAt.Add(-time.Hour)
	if got := evaluateWikiFreshness([]WikiPageRow{page}, refsByPage, articles); got.StalePageCount != 0 {
		t.Fatalf("StalePageCount = %d，源文档更旧时不应失效", got.StalePageCount)
	}
}

func TestEvaluateWikiFreshnessIgnoresMissingArticles(t *testing.T) {
	frontmatter := `{"buildVersion":` + strconv.Itoa(ArticleKnowledgeBuildVersion) + `}`
	page := WikiPageRow{
		ID: 3, KnowledgeBaseID: 1, Kind: "concept", PageKey: "concept-z", Title: "概念 Z",
		FrontmatterJson: &frontmatter, UpdatedAt: time.Now(),
	}
	refsByPage := map[int64][]SourceRefRow{page.ID: {{PageID: page.ID, ArticleID: 404}}}
	freshness := evaluateWikiFreshness([]WikiPageRow{page}, refsByPage, map[int64]*ArticleRow{})
	if freshness.StalePageCount != 0 {
		t.Fatalf("StalePageCount = %d，引用的文章不存在时不应算陈旧", freshness.StalePageCount)
	}
}

func TestOutdatedBuildReason(t *testing.T) {
	withFrontmatter := func(raw string) *WikiPageRow {
		return &WikiPageRow{ID: 1, Kind: "concept", PageKey: "p", FrontmatterJson: &raw}
	}

	if reason := outdatedBuildReason(withFrontmatter(`{"buildVersion":1}`)); reason == nil ||
		reason.Code != wikiIssueOutdatedBuil {
		t.Fatalf("旧编译版本应报 outdated_build，实际 %#v", reason)
	}
	current := `{"buildVersion":` + strconv.Itoa(ArticleKnowledgeBuildVersion) +
		`,"chunkAlgorithmVersion":` + strconv.Itoa(ChunkAlgorithmVersion) + `}`
	if reason := outdatedBuildReason(withFrontmatter(current)); reason != nil {
		t.Fatalf("当前版本不应报问题，实际 %#v", reason)
	}
	if reason := outdatedBuildReason(withFrontmatter(`{}`)); reason != nil {
		t.Fatalf("非 LLM 编译产物不参与判定，实际 %#v", reason)
	}
	staleChunk := `{"buildVersion":` + strconv.Itoa(ArticleKnowledgeBuildVersion) +
		`,"chunkAlgorithmVersion":1}`
	if ChunkAlgorithmVersion > 1 {
		if reason := outdatedBuildReason(withFrontmatter(staleChunk)); reason == nil {
			t.Fatal("分片算法落后应报 outdated_build")
		}
	}
}

func TestOutdatedBuildAndStaleSourceCoexist(t *testing.T) {
	compiledAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	article := &ArticleRow{
		ID: 1, Title: "标题", ContentMd: "新正文",
		UpdatedAt: time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC),
	}
	frontmatter := `{"buildVersion":1,"sourceHash":"` + sha256Hex("标题\n旧正文") + `"}`
	page := WikiPageRow{
		ID: 10, KnowledgeBaseID: 1, Kind: "source",
		PageKey: buildArticleWikiSourcePageKey(1), Title: "源文档",
		FrontmatterJson: &frontmatter, UpdatedAt: compiledAt,
	}
	refsByPage := map[int64][]SourceRefRow{page.ID: {{PageID: page.ID, ArticleID: 1}}}

	reasons := evaluateWikiFreshness([]WikiPageRow{page}, refsByPage,
		map[int64]*ArticleRow{1: article}).ReasonsByPage[page.ID]
	if len(reasons) != 2 {
		t.Fatalf("原因数量 = %d，内容变更与编译版本落后应同时报出：%#v", len(reasons), reasons)
	}
}
