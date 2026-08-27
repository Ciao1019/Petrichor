package runtime

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnnotateNormalQaWikiMentionsMarksTableCells(t *testing.T) {
	targets := []WikiMentionTarget{
		{PageKey: "concept-deep-clean", Title: "深度清理", Aliases: []string{"深度清理"}, Kind: "concept"},
		{PageKey: "entity-homebrew", Title: "Homebrew", Aliases: []string{}, Kind: "entity"},
	}
	input := "| 功能 | 说明 |\n| --- | --- |\n| **深度清理** | 清理缓存 |\n\n推荐用 Homebrew 安装。"
	got := AnnotateNormalQaWikiMentions(input, targets)

	if !strings.Contains(got, "| **[[concept-deep-clean|深度清理]]** | 清理缓存 |") {
		t.Fatalf("table Wiki mention was not annotated:\n%s", got)
	}
	if !strings.Contains(got, "[[entity-homebrew|Homebrew]]") {
		t.Fatalf("paragraph Wiki mention was not annotated:\n%s", got)
	}
}

func TestAnnotateNormalQaWikiMentionsProtectsMarkdownAndOnlyLinksFirstMention(t *testing.T) {
	targets := []WikiMentionTarget{{PageKey: "entity-mole", Title: "Mole", Kind: "entity"}}
	input := "`Mole` [Mole](https://example.com)\n\n| 工具 | 说明 |\n| --- | --- |\n| Mole | Mole 工具 |\n\n```sh\nMole\n```"
	got := AnnotateNormalQaWikiMentions(input, targets)

	if strings.Count(got, "[[entity-mole|Mole]]") != 1 {
		t.Fatalf("expected exactly one Wiki mention:\n%s", got)
	}
	if !strings.Contains(got, "`Mole` [Mole](https://example.com)") || !strings.Contains(got, "```sh\nMole\n```") {
		t.Fatalf("protected Markdown changed:\n%s", got)
	}
}

func TestCollectAndEmitWikiMentionTargetsSupportsHitsAndItems(t *testing.T) {
	observations := NewObservationStore()
	observations.Add(CreateObservation(
		"tool_result", "knowledge.lookup", "命中", json.RawMessage(`{"hits":[{"pageKey":"concept-deep-clean","title":"深度清理"}],"items":[{"pageKey":"entity-homebrew","title":"Homebrew","kind":"entity","aliases":["brew"]}],"pages":[{"pageKey":"concept-system-monitor","title":"系统监控","kind":"concept"}]}`),
		nil, nil, false, 1,
	))
	evidence := NewEvidenceStore()
	evidence.Add(AgentEvidence{
		Source: EvidenceWiki, Title: "深度清理", Content: "正文",
		Metadata: map[string]any{"pageKey": "concept-deep-clean", "kind": "concept"},
	})

	seen := []*AgentStreamEvent{}
	events := NewAgentEventEmitter("run-wiki", func(event *AgentStreamEvent) { seen = append(seen, event) })
	targets := EmitWikiMentionTargets(events, observations, evidence)

	if len(targets) != 3 || targets[0].PageKey != "concept-deep-clean" || targets[0].CitationIndex == nil {
		t.Fatalf("unexpected targets: %#v", targets)
	}
	if len(targets[1].Aliases) != 1 || targets[1].Aliases[0] != "brew" {
		t.Fatalf("Wiki search aliases were not preserved: %#v", targets[1])
	}
	if len(seen) != 1 || seen[0].Type != "wiki_mention_targets" {
		t.Fatalf("unexpected stream events: %#v", seen)
	}
	var payload struct {
		Targets []WikiMentionTarget `json:"targets"`
	}
	if json.Unmarshal(seen[0].Payload, &payload) != nil || len(payload.Targets) != 3 {
		t.Fatalf("invalid event payload: %s", seen[0].Payload)
	}
}
