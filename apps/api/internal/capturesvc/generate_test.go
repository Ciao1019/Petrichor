package capturesvc

import (
	"strings"
	"testing"
)

func TestSplitPreservesEntireSource(t *testing.T) {
	source := strings.Repeat("这是中文段落，与 emoji 🌧️ 一起保存。\n", 3000)
	chunks := splitText(source, 18000)
	if strings.Join(chunks, "") != source {
		t.Fatal("分段丢失正文")
	}
	for _, c := range chunks {
		if len([]rune(c)) > 18000 {
			t.Fatal("分段超过预算")
		}
	}
}
func TestDiffRetainsChanges(t *testing.T) {
	got := diff("标题\n旧内容\n末尾", "标题\n新内容\n末尾")
	if !strings.Contains(got, "- 旧内容") || !strings.Contains(got, "+ 新内容") || strings.Contains(got, "- 标题") {
		t.Fatal(got)
	}
	if diff("相同", "相同") != "内容未变化" {
		t.Fatal("错误变更判断")
	}
}
