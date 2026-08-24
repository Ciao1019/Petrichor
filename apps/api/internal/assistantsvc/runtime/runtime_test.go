package runtime

import (
	"testing"
)

func TestDetectComplexity(t *testing.T) {
	cases := []struct {
		goal string
		want TaskComplexity
	}{
		{"你好", ComplexityDirect},
		{"1+1等于多少?", ComplexityDirect},
		{"X 是什么", ComplexitySimple},
		{"分别研究 A 和 B 的技术选型并给出可行性分析", ComplexityComplex},
	}
	for _, c := range cases {
		got := DetectComplexity(ComplexityInput{Goal: c.goal})
		if got.Complexity != c.want {
			t.Fatalf("goal=%q want=%s got=%s (score=%d)", c.goal, c.want, got.Complexity, got.Score)
		}
	}
}

func TestLoopDetectorExactRepeat(t *testing.T) {
	d := NewLoopDetector(4)
	var signal *LoopSignal
	for i := 0; i < 3; i++ {
		signal = d.Record("knowledge.search", map[string]any{"query": "x"}, nil, false)
	}
	if signal == nil || signal.Kind != "exact_repeat" {
		t.Fatalf("expected exact_repeat, got %+v", signal)
	}
}

func TestLoopDetectorNoProgress(t *testing.T) {
	d := NewLoopDetector(3)
	for i := 0; i < 2; i++ {
		if s := d.Record("tool.a", map[string]any{"q": i}, nil, false); s != nil {
			t.Fatalf("unexpected signal at %d: %+v", i, s)
		}
	}
	signal := d.Record("tool.b", map[string]any{}, nil, false)
	if signal == nil || signal.Kind != "no_evidence_progress" {
		t.Fatalf("expected no_evidence_progress at 3rd no-evidence call, got %+v", signal)
	}
}

func TestQuerySimilarity(t *testing.T) {
	if QuerySimilarity("知识库检索", "知识库检索") != 1 {
		t.Fatal("identical queries should be 1")
	}
	sim := QuerySimilarity("重复消费怎么处理", "重复消费的处理")
	if sim < 0.4 {
		t.Fatalf("similar queries should have high similarity, got %f", sim)
	}
	if QuerySimilarity("abc", "xyz") > 0.2 {
		t.Fatal("dissimilar queries should be low")
	}
}

func TestEvidenceStoreDedupBySourceID(t *testing.T) {
	store := NewEvidenceStore()
	first := store.Add(EvidenceInput{
		Source: EvidenceKnowledge, Title: "T", Content: "内容",
		SourceID: "42", Metadata: map[string]any{},
	})
	dup := store.Add(EvidenceInput{
		Source: EvidenceKnowledge, Title: "", Content: "更长的内容内容",
		SourceID: "42", Metadata: map[string]any{},
	})
	if store.Size() != 1 {
		t.Fatalf("expected 1 evidence after dedup, got %d", store.Size())
	}
	if first.ID != dup.ID {
		t.Fatal("dedup should return same id")
	}
	if dup.Content != "更长的内容内容" {
		t.Fatal("merge should keep longer content")
	}
	if dup.Title != "T" {
		t.Fatal("merge should keep existing title when incoming empty")
	}
}

func TestEvidenceCitationIndexStable(t *testing.T) {
	store := NewEvidenceStore()
	a := store.Add(EvidenceInput{Source: EvidenceKnowledge, Content: "A", SourceID: "a", Metadata: map[string]any{}})
	b := store.Add(EvidenceInput{Source: EvidenceKnowledge, Content: "B", SourceID: "b", Metadata: map[string]any{}})
	if store.CitationIndex(a.ID) != 1 || store.CitationIndex(b.ID) != 2 {
		t.Fatal("citation index should follow insertion order")
	}
}

func TestStopPolicyEnoughEvidence(t *testing.T) {
	state := NewAgentStateStore("run", "conv", "u", "goal", ComplexitySimple, nowMs())
	state.AddEvidence([]AgentEvidence{{ID: "e1"}})
	config := StopPolicyConfig{AgentBudget: AgentBudget{MaxIterations: 4, MaxToolCalls: 1, MaxExecutionMs: 120000}, MaxNoProgressIterations: 3}
	policy := NewStopPolicy(config, NewBudgetTracker(config.AgentBudget, nowMs()), NewLoopDetector(4))
	state.IncrementToolCall()
	decision := policy.EvaluateAfterToolCall(state.Current())
	if !decision.Stop || decision.Reason != StopEnoughEvidence {
		t.Fatalf("expected enough_evidence, got %+v", decision)
	}
}

func TestObservationDedup(t *testing.T) {
	store := NewObservationStore()
	a := CreateObservation("t", "s", "摘要", nil, []string{"e1"}, nil, false, nowMs())
	b := CreateObservation("t", "s", "摘要", nil, []string{"e2"}, nil, false, nowMs())
	store.Add(a)
	merged := store.Add(b)
	if store.Size() != 1 {
		t.Fatalf("expected merged observation, size=%d", store.Size())
	}
	if len(merged.EvidenceIDs) != 2 {
		t.Fatalf("expected merged evidence ids, got %+v", merged.EvidenceIDs)
	}
}

func TestStableHashKeyOrderIndependent(t *testing.T) {
	h1 := StableHash(map[string]any{"a": 1, "b": 2})
	h2 := StableHash(map[string]any{"b": 2, "a": 1})
	if h1 != h2 {
		t.Fatal("hash should be key-order independent")
	}
}

func TestContextManagerBuildIncludesSections(t *testing.T) {
	state := NewAgentStateStore("run", "conv", "u", "目标G", ComplexityMultiStep, nowMs())
	obs := NewObservationStore()
	evidence := NewEvidenceStore()
	evidence.Add(EvidenceInput{Source: EvidenceKnowledge, Title: "页面", Content: "证据正文", SourceID: "n1", Metadata: map[string]any{"pageKey": "pk"}})
	cm := NewContextManager(ResolveContextBudget(100000))
	built := cm.Build(ContextBuildInput{
		State: state.Current(), Observations: obs, Evidence: evidence,
		SkillCatalog: []AgentSkill{{ID: "knowledge", Name: "知识库", Description: "检索"}},
		Tools:        []*AgentToolDefinition{},
		QaMode:       "wiki",
	})
	for _, want := range []string{"## 当前目标", "## 已获取证据", "[[pk|页面]]", "可加载的能力"} {
		if !contains(built.Instructions, want) {
			t.Fatalf("instructions missing %q:\n%s", want, built.Instructions)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestAnswerQualityGate(t *testing.T) {
	goal := "X 是什么？请完整介绍"
	rich := make([]AgentEvidence, 1)
	rich[0] = AgentEvidence{Content: stringsRepeat("很长的证据内容。", 60)}
	result := AssessAnswerQuality(goal, "一句话答案", rich)
	if result.Adequate {
		t.Fatal("one-liner against rich evidence should fail quality gate")
	}
}

func stringsRepeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func TestShouldUseFastPath(t *testing.T) {
	if !ShouldUseSimpleKnowledgeFastPath("X 是什么", ComplexitySimple, nil, nil) {
		t.Fatal("simple definition question should hit fast path")
	}
	if ShouldUseSimpleKnowledgeFastPath("帮我创建一个知识库", ComplexitySimple, nil, nil) {
		t.Fatal("write actions must not hit fast path")
	}
	if ShouldUseSimpleKnowledgeFastPath("X 是什么", ComplexityComplex, nil, nil) {
		t.Fatal("complex tasks must not hit fast path")
	}
}

func TestMapDomainsToSkills(t *testing.T) {
	got := MapDomainsToSkills([]string{"knowledge", "doc_library", "unknown"}, []string{"knowledge", "documents"})
	if len(got) != 2 || got[0] != "knowledge" || got[1] != "documents" {
		t.Fatalf("unexpected mapping: %+v", got)
	}
}
