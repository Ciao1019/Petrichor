package publicscope

import "testing"

func TestWikiMetadataRejectsPrivateOrUntraceableContributions(t *testing.T) {
	articles := map[int64]*ArticleRef{1: {ArticleID: 1}, 2: {ArticleID: 2}}
	for _, test := range []struct {
		name, raw string
		want      bool
	}{
		{"旧页面仍按 SQL 来源检查", "{}", true},
		{"公开源文档", `{"articleId":"1"}`, true},
		{"公开聚合", `{"contributions":{"1":{"articleId":"1"},"2":{"articleId":2}}}`, true},
		{"已删除来源的正文残留", `{"contributions":{"1":{"articleId":"1"},"99":{"articleId":"99"}}}`, false},
		{"私有源文档", `{"articleId":"99"}`, false},
		{"无来源旧正文", `{"baseContentMd":"旧知识库内部说明","contributions":{"1":{}}}`, false},
		{"无来源旧摘要", `{"baseSummary":"内部摘要"}`, false},
		{"来源不一致", `{"contributions":{"1":{"articleId":"2"}}}`, false},
		{"未知结构", `{"contributions":[]}`, false},
		{"无效元数据", `{invalid`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := wikiMetadataIsPublic(&test.raw, articles); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}
