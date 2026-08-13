package kb

import (
	"testing"
)

func TestBuildArticleAiSummaryContentHash(t *testing.T) {
	hash := BuildArticleAiSummaryContentHash("# Hello\n\nWorld")
	if len(hash) != 32 {
		t.Fatalf("expected md5 hex length 32, got %q", hash)
	}
	if BuildArticleAiSummaryContentHash("same") != BuildArticleAiSummaryContentHash("same") {
		t.Fatal("hash should be deterministic")
	}
	if BuildArticleAiSummaryContentHash("a") == BuildArticleAiSummaryContentHash("b") {
		t.Fatal("hash should differ for different content")
	}
}

func TestBuildMindmapContentHash(t *testing.T) {
	hash := BuildMindmapContentHash("标题", "正文")
	if len(hash) != 64 {
		t.Fatalf("expected sha256 hex length 64, got %q", hash)
	}
	if BuildMindmapContentHash("标题", "正文") != BuildMindmapContentHash("标题", "正文") {
		t.Fatal("hash should be deterministic")
	}
	if BuildMindmapContentHash("标题", "正文") == BuildMindmapContentHash("标题", "其他") {
		t.Fatal("hash should include content")
	}
}

func TestNormalizeArticleSummaryModelOutput(t *testing.T) {
	got, err := NormalizeArticleSummaryModelOutput("```markdown\n这是一段摘要内容。\n```")
	if err != nil {
		t.Fatal(err)
	}
	if got != "这是一段摘要内容。" {
		t.Fatalf("unexpected normalized summary: %q", got)
	}

	got, err = NormalizeArticleSummaryModelOutput("摘要：核心观点说明")
	if err != nil {
		t.Fatal(err)
	}
	if got != "核心观点说明" {
		t.Fatalf("unexpected prefix strip: %q", got)
	}

	longRunes := make([]rune, 500)
	for i := range longRunes {
		longRunes[i] = '测'
	}
	got, err = NormalizeArticleSummaryModelOutput(string(longRunes))
	if err != nil {
		t.Fatal(err)
	}
	if len([]rune(got)) > articleSummaryMaxChars+3 {
		t.Fatalf("summary should be truncated, len=%d", len([]rune(got)))
	}
	if got[len(got)-3:] != "..." {
		t.Fatalf("expected ellipsis suffix, got %q", got)
	}

	if _, err := NormalizeArticleSummaryModelOutput("   "); err == nil {
		t.Fatal("expected error for empty output")
	}
}

func TestIsArticleAiSummaryCacheHit(t *testing.T) {
	if !IsArticleAiSummaryCacheHit("abc", "abc", "摘要") {
		t.Fatal("expected cache hit")
	}
	if IsArticleAiSummaryCacheHit("abc", "def", "摘要") {
		t.Fatal("expected cache miss on hash mismatch")
	}
	if IsArticleAiSummaryCacheHit("abc", "abc", "  ") {
		t.Fatal("expected cache miss on empty summary")
	}
}
