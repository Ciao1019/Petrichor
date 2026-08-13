package kb

import (
	"reflect"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func TestWikiDedupRejectReason(t *testing.T) {
	allowed := map[string]struct{}{"entity/mole": {}, "concept/cleanup": {}}
	cases := []struct {
		name       string
		from, to   string
		wantReject bool
	}{
		{"合法合并", "entity/xiao-yan-shu", "entity/mole", false},
		{"目标不在候选内", "entity/xiao-yan-shu", "entity/zsh", true},
		{"类型不一致", "entity/xiao-yan-shu", "concept/cleanup", true},
		{"合并到自身", "entity/mole", "entity/mole", true},
		{"缺少类型前缀", "mole", "entity/mole", true},
		{"空 slug", "", "entity/mole", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := wikiDedupRejectReason(tc.from, tc.to, allowed)
			if (reason != "") != tc.wantReject {
				t.Fatalf("wikiDedupRejectReason(%q, %q) = %q，期望拒绝=%v", tc.from, tc.to, reason, tc.wantReject)
			}
		})
	}
}

func TestApplyWikiDedupMerges(t *testing.T) {
	items := []wikiExtractedItem{
		{Name: "小鼹鼠", Slug: "entity/xiao-yan-shu", Aliases: []string{"Mole CLI"}},
		{Name: "Zsh", Slug: "entity/zsh"},
	}

	t.Run("空重写表原样返回", func(t *testing.T) {
		got := applyWikiDedupMerges(items, nil)
		if len(got) != 2 || got[0].Slug != "entity/xiao-yan-shu" {
			t.Fatalf("空重写表不应改动条目，实际 %+v", got)
		}
	})

	t.Run("重写 slug 并把原名保留为别名", func(t *testing.T) {
		got := applyWikiDedupMerges(items, map[string]string{"entity/xiao-yan-shu": "entity/mole"})
		if got[0].Slug != "entity/mole" {
			t.Fatalf("slug 未被重写：%q", got[0].Slug)
		}
		if !containsString(got[0].Aliases, "小鼹鼠") {
			t.Fatalf("原名应保留为别名，实际 %q", got[0].Aliases)
		}
		if got[1].Slug != "entity/zsh" {
			t.Fatalf("未涉及的条目不应被改动：%q", got[1].Slug)
		}
	})

	t.Run("合并后同 slug 的条目去重，别名与证据分片都并入目标", func(t *testing.T) {
		duplicated := []wikiExtractedItem{
			{Name: "Mole", Slug: "entity/mole", Aliases: []string{"mole"}, SourceChunks: []int{0, 2}},
			{Name: "小鼹鼠", Slug: "entity/xiao-yan-shu", SourceChunks: []int{2, 5}},
		}
		got := applyWikiDedupMerges(duplicated, map[string]string{"entity/xiao-yan-shu": "entity/mole"})
		if len(got) != 1 {
			t.Fatalf("同 slug 条目应合并为一条，实际 %d 条", len(got))
		}
		if !containsString(got[0].Aliases, "小鼹鼠") || !containsString(got[0].Aliases, "mole") {
			t.Fatalf("别名未合并完整：%q", got[0].Aliases)
		}
		if !reflect.DeepEqual(got[0].SourceChunks, []int{0, 2, 5}) {
			t.Fatalf("证据分片应去重合并为 [0 2 5]，实际 %v", got[0].SourceChunks)
		}
	})
}

func TestWikiBigramsAndJaccard(t *testing.T) {
	if got := wikiBigrams("猫"); !reflect.DeepEqual(got, map[string]struct{}{"猫": {}}) {
		t.Fatalf("单字符应退化为自身，实际 %v", got)
	}
	if len(wikiBigrams("")) != 0 {
		t.Fatal("空串不应产生二元组")
	}
	// 大小写与空白归一后，两者应完全一致。
	if score := wikiJaccard(wikiBigrams("Acme Corp"), wikiBigrams("acmecorp")); score != 1 {
		t.Fatalf("归一化后应完全相同，实际 %v", score)
	}
	if score := wikiJaccard(wikiBigrams("Acme Corp"), wikiBigrams("Acme Corporation")); score < wikiDedupScoreFloor {
		t.Fatalf("缩写与全称应高于下限，实际 %v", score)
	}
	if score := wikiJaccard(wikiBigrams("城镇登记失业人员"), wikiBigrams("中华优秀传统文化")); score >= wikiDedupScoreFloor {
		t.Fatalf("毫不相干的词应低于下限，实际 %v", score)
	}
}

func TestWikiSlugBaseTokens(t *testing.T) {
	got := wikiSlugBaseTokens("entity/spring-festival")
	if !reflect.DeepEqual(got, map[string]struct{}{"spring": {}, "festival": {}}) {
		t.Fatalf("slug 词元拆分不符：%v", got)
	}
}

func TestSelectWikiDedupCandidatesSmallCorpus(t *testing.T) {
	// 页面数少于 bypass 阈值时全部作为候选，不做预筛。
	pages := []*ent.KBWikiPage{
		{PageKey: "entity/mole", Title: "Mole"},
		{PageKey: "entity/zsh", Title: "Zsh"},
	}
	items := []wikiExtractedItem{{Name: "小鼹鼠", Slug: "entity/xiao-yan-shu"}}
	got := selectWikiDedupCandidates(items, pages)
	if len(got["entity/xiao-yan-shu"]) != 2 {
		t.Fatalf("小规模语料应全量作为候选，实际 %d", len(got["entity/xiao-yan-shu"]))
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
