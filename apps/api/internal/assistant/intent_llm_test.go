package assistant

import "testing"

func TestParseIntentLLMJSON(t *testing.T) {
	obj, err := parseIntentLLMJSON("```json\n{\"domains\":[\"knowledge\",\"system\"],\"confidence\":0.72,\"rationale\":\"查知识库\"}\n```")
	if err != nil {
		t.Fatal(err)
	}
	if len(obj.Domains) != 2 || obj.Domains[0] != "knowledge" {
		t.Fatalf("unexpected domains: %+v", obj.Domains)
	}
	if obj.Confidence < 0.7 {
		t.Fatalf("confidence=%v", obj.Confidence)
	}
}

func TestMergeAdminDomainFromRules(t *testing.T) {
	merged := mergeAdminDomainFromRules(
		[]AgentDomainId{DomainKnowledge},
		[]AgentDomainId{DomainAdmin},
	)
	if !merged.kept || !hasAdminDomainCandidate(merged.domains) {
		t.Fatalf("expected admin kept: %+v", merged)
	}
}

func TestNeedsIntentLLM(t *testing.T) {
	if !NeedsIntentLLM(IntentRouteResult{Confidence: 0.3}) {
		t.Fatal("low confidence should need llm")
	}
	if !NeedsIntentLLM(IntentRouteResult{Confidence: 0.9, Domains: []AgentDomainId{DomainAdmin}}) {
		t.Fatal("admin should need llm")
	}
	if NeedsIntentLLM(IntentRouteResult{Confidence: 0.8, Domains: []AgentDomainId{DomainKnowledge}}) {
		t.Fatal("high confidence knowledge should skip llm")
	}
}

func TestSanitizeResearchDomains(t *testing.T) {
	got := sanitizeResearchDomains([]string{"knowledge", "admin", "content_write", "legacy_domain"})
	if len(got) != 1 || got[0] != DomainKnowledge {
		t.Fatalf("got=%v", got)
	}
}

func TestFilterSubagentToolNames(t *testing.T) {
	names := []string{"search_knowledge", "spawn_research_subagent", "create_article", "show_citations"}
	filtered := filterSubagentToolNames(names, false)
	for _, n := range filtered {
		if n == "spawn_research_subagent" || n == "create_article" {
			t.Fatalf("should block %s", n)
		}
	}
	withRespawn := filterSubagentToolNames(names, true)
	found := false
	for _, n := range withRespawn {
		if n == "spawn_research_subagent" {
			found = true
		}
	}
	if !found {
		t.Fatal("allowRespawn should keep spawn_research_subagent")
	}
}

func TestNormalizeProposedWriteActions(t *testing.T) {
	actions := normalizeProposedWriteActions([]proposedWriteAction{
		{ToolName: "create_article", Input: map[string]any{"title": "a"}},
		{ToolName: "delete_article", Input: map[string]any{"id": "1"}},
		{ToolName: "unknown_tool", Input: map[string]any{}},
	})
	if len(actions) != 2 {
		t.Fatalf("got=%v", actions)
	}
	if actions[1].Risk != "dangerous" {
		t.Fatalf("delete should be dangerous: %+v", actions[1])
	}
}

func TestResolveSpawnDepthPolicyRoot(t *testing.T) {
	depth, maxDepth := resolveSpawnDepthPolicy(t.Context(), nil, nil)
	if depth != 0 || maxDepth != subagentDefaultMaxDepth {
		t.Fatalf("depth=%d max=%d", depth, maxDepth)
	}
}
