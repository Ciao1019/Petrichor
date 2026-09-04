package assistantsvc

import (
	"reflect"
	"strings"
	"testing"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func TestAssistantSkillToolContractsStayAligned(t *testing.T) {
	registry := rt.NewToolRegistry()
	skills := rt.NewSkillRegistry()
	RegisterAssistantTools(registry, skills)

	want := map[string][]string{
		"admin": {"admin.list_models", "admin.bind_model", "admin.list_api_keys", "admin.get_public_qa", "agent.request_confirmation"},
		"documents": {
			"document.list_libraries", "document.search", "document.read", "document.export",
			"document.create", "document.update", "document.preview_update", "document.move", "document.share",
			"agent.request_confirmation",
		},
		"knowledge": {
			"knowledge.lookup", "knowledge.search", "knowledge.outline",
			"knowledge.read_many", "knowledge.read", "knowledge.list_bases",
		},
		"memory":   {"memory.search", "memory.write", "memory.update", "memory.delete"},
		"research": {"research.search", "research.fetch", "research.extract"},
		"system":   {"system.overview"},
		"writer":   {"writer.compose", "writer.rewrite", "writer.summarize", "writer.structure", "writer.save_artifact"},
	}
	for skillID, toolIDs := range want {
		skill := skills.Get(skillID)
		if skill == nil {
			t.Fatalf("missing skill %s", skillID)
		}
		if strings.Join(skill.ToolIDs, ",") != strings.Join(toolIDs, ",") {
			t.Fatalf("skill %s tool ids changed: got %#v want %#v", skillID, skill.ToolIDs, toolIDs)
		}
		for _, toolID := range skill.ToolIDs {
			if !registry.Has(toolID) {
				t.Fatalf("skill %s advertises unregistered tool %s", skillID, toolID)
			}
		}
	}
}

func TestDocumentWriteToolContracts(t *testing.T) {
	registry := rt.NewToolRegistry()
	registerDocumentTools(registry)
	want := map[string]string{
		"document.create": "create_article", "document.update": "update_article",
		"document.preview_update": "preview_article_update", "document.move": "move_article",
		"document.share": "create_article_share",
	}
	for id, publicName := range want {
		tool := registry.Get(id)
		if tool == nil || tool.Name != publicName {
			t.Fatalf("tool %s missing or public name mismatch: %#v", id, tool)
		}
		if id != "document.preview_update" && (!tool.SideEffect || tool.RiskLevel != rt.RiskMedium) {
			t.Fatalf("write tool %s must be a medium side effect", id)
		}
		if tool.AllowsSubAgent() {
			t.Fatalf("document write tool %s must not be delegated", id)
		}
	}
}

func TestBuildUnifiedDiffMatchesAssistantPreviewContract(t *testing.T) {
	got := buildUnifiedDiff("标题\n旧内容", "标题\n新内容", "content.md")
	want := "--- a/content.md\n+++ b/content.md\n@@ line 2 @@\n-旧内容\n+新内容"
	if got != want {
		t.Fatalf("unexpected diff:\n%s", got)
	}
	unchanged := buildUnifiedDiff("相同", "相同", "content.md")
	if !strings.Contains(unchanged, "@@ unchanged @@") {
		t.Fatalf("unchanged diff marker missing: %q", unchanged)
	}
}

func TestInsertAssistantNodeAtIsStableAndClamped(t *testing.T) {
	index := 1
	got := insertAssistantNodeAt([]int64{1, 2, 3}, 2, &index)
	if !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("unexpected order: %#v", got)
	}
	far := 99
	got = insertAssistantNodeAt([]int64{1, 3}, 2, &far)
	if len(got) != 3 || got[2] != 2 {
		t.Fatalf("target index must clamp to tail: %#v", got)
	}
}

func TestApplyOperatorMemoryMutationMatchesLimitsAndExactPatch(t *testing.T) {
	profile, notes, code := applyOperatorMemoryMutation("偏好中文", "先给结论", "add", "user_profile", "使用 Go", "")
	if code != "" || profile != "偏好中文\n使用 Go" || notes != "先给结论" {
		t.Fatalf("add failed: profile=%q notes=%q code=%q", profile, notes, code)
	}
	profile, notes, code = applyOperatorMemoryMutation(profile, notes, "replace", "agent_notes", "先给结论", "先给结论，再给验证")
	if code != "" || notes != "先给结论，再给验证" {
		t.Fatalf("replace failed: profile=%q notes=%q code=%q", profile, notes, code)
	}
	_, _, code = applyOperatorMemoryMutation(profile, notes, "remove", "agent_notes", "不存在", "")
	if code != "invalid_patch" {
		t.Fatalf("non-exact removal must fail closed, got %q", code)
	}
	_, _, code = applyOperatorMemoryMutation(strings.Repeat("字", operatorUserProfileMax), notes, "add", "user_profile", "超", "")
	if code != "memory_limit_exceeded" {
		t.Fatalf("memory limit must be enforced, got %q", code)
	}
}

func TestMergeOperatorHistoryHitsPrefersSemanticAndDeduplicates(t *testing.T) {
	semantic := []operatorHistoryHit{{ThreadID: "1", MessageID: "2", Source: "semantic"}}
	keyword := []operatorHistoryHit{
		{ThreadID: "1", MessageID: "2", Source: "keyword"},
		{ThreadID: "3", MessageID: "4", Source: "keyword"},
	}
	got := mergeOperatorHistoryHits(semantic, keyword, 8)
	if len(got) != 2 || got[0].Source != "semantic" || got[1].MessageID != "4" {
		t.Fatalf("unexpected merge: %#v", got)
	}
}
