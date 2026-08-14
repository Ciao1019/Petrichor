package kb

import (
	"encoding/json"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func TestWikiCitationResultAcceptsScalarStringLists(t *testing.T) {
	var result wikiCitationResult
	raw := `{"citations":{"entity/mole":"c001"},"new_slugs":[{"type":"entity","name":"Mole","slug":"entity/mole","aliases":"小鼹鼠","source_chunks":"c002"}]}`
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	if got := result.Citations["entity/mole"]; len(got) != 1 || got[0] != "c001" {
		t.Fatalf("unexpected citations: %#v", got)
	}
	if got := result.NewSlugs[0].Aliases; len(got) != 1 || got[0] != "小鼹鼠" {
		t.Fatalf("unexpected aliases: %#v", got)
	}
}

func TestMergeWikiDocumentIDsSortsAndDeduplicates(t *testing.T) {
	got := mergeWikiDocumentIDs([]int64{4, 2, 2}, []int64{3, 4, 1, 0})
	want := []int64{1, 2, 3, 4}
	if len(got) != len(want) {
		t.Fatalf("合并文档 ID 数量异常：%#v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("合并文档 ID 应为 %#v，实际 %#v", want, got)
		}
	}
}

func TestWikiJobContainsAllDocuments(t *testing.T) {
	job := &ent.KBWikiIngestJob{DocumentIdsJSON: "[1,2,3]"}
	if !wikiJobContainsAllDocuments(job, []int64{3, 1}) {
		t.Fatal("任务应包含指定文档")
	}
	if wikiJobContainsAllDocuments(job, []int64{4}) {
		t.Fatal("任务不应包含不存在的文档")
	}
}

func TestLinkifyWikiContentSkipsCodeAndExistingMarkdownLinks(t *testing.T) {
	content := "`Mole` [Mole](https://example.com)\n\nMole 支持 Homebrew。\n```sh\nHomebrew install\n```"
	linked, changed := linkifyWikiContent(content, []wikiLinkRef{
		{slug: "entity/mole", text: "Mole"},
		{slug: "entity/homebrew", text: "Homebrew"},
	}, "summary/1")
	if !changed {
		t.Fatal("expected content to change")
	}
	if linked != "`Mole` [Mole](https://example.com)\n\n[[entity/mole|Mole]] 支持 [[entity/homebrew|Homebrew]]。\n```sh\nHomebrew install\n```" {
		t.Fatalf("unexpected linkified content:\n%s", linked)
	}
}

func TestValidateWikiCitationEvidenceDropsPassingMentionAndCapsBroadSubject(t *testing.T) {
	context := "## 主要功能\n\n这里解释 Mole 的功能。"
	chunks := []*ent.KBDocumentChunk{
		{ChunkIndex: 0, Text: context},
		{ChunkIndex: 1, Text: "命令行工具只在这里被顺带提到。"},
		{ChunkIndex: 2, Text: "## Mole 安装\n\nMole 可以通过 Homebrew 安装，并使用 mo 命令启动。"},
	}
	passing := validateWikiCitationEvidence(wikiExtractedItem{Name: "命令行工具"}, []int{1}, chunks, context+chunks[1].Text)
	if len(passing) != 0 {
		t.Fatalf("passing mention should be rejected: %#v", passing)
	}
	subject := validateWikiCitationEvidence(wikiExtractedItem{Name: "Mole"}, []int{0, 1, 2}, chunks, context+chunks[2].Text)
	if len(subject) != 2 || subject[0] != 0 || subject[1] != 2 {
		t.Fatalf("only chunks mentioning the subject should remain: %#v", subject)
	}
}

func TestValidateWikiCitationEvidenceAcceptsDedicatedMixedLanguageSections(t *testing.T) {
	touchID := []*ent.KBDocumentChunk{
		{ChunkIndex: 18, Text: "### Touch ID 授权\n\n让 Mole 使用指纹完成管理员授权。"},
		{ChunkIndex: 19, Text: "运行 mo touchid 后，sudo 命令会弹出 Touch ID 认证窗口，轻触指纹即可授权。"},
	}
	touchDocument := touchID[0].Text + "\n" + touchID[1].Text
	gotTouch := validateWikiCitationEvidence(wikiExtractedItem{Name: "Touch ID 授权"}, []int{19}, touchID, touchDocument)
	if len(gotTouch) != 1 || gotTouch[0] != 19 {
		t.Fatalf("Touch ID core term should keep substantive evidence: %#v", gotTouch)
	}

	completion := []*ent.KBDocumentChunk{
		{ChunkIndex: 20, Text: "### Shell 自动补全\n\n启用 Tab 键自动补全 Mole 命令。配置后会提示可用命令。"},
	}
	gotCompletion := validateWikiCitationEvidence(wikiExtractedItem{Name: "Shell 自动补全"}, []int{20}, completion, completion[0].Text)
	if len(gotCompletion) != 1 || gotCompletion[0] != 20 {
		t.Fatalf("dedicated auto-completion section should remain: %#v", gotCompletion)
	}
}
