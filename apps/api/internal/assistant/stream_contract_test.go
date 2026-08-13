package assistant

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func TestAssistantChatIDsAreStrict(t *testing.T) {
	for _, raw := range []string{`"12"`, `12`} {
		var id assistantID
		if err := json.Unmarshal([]byte(raw), &id); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		parsed, err := parseOptionalChatID(&id, "threadId")
		if err != nil || parsed == nil || *parsed != 12 {
			t.Fatalf("parse %s = %v, %v", raw, parsed, err)
		}
	}

	for _, raw := range []string{`"12abc"`, `"0"`, `""`, `1e2`} {
		var id assistantID
		if err := json.Unmarshal([]byte(raw), &id); err != nil {
			continue
		}
		if _, err := parseOptionalChatID(&id, "threadId"); err == nil {
			t.Fatalf("expected %s to be rejected", raw)
		}
	}
}

func TestAssistantToolIDInputsAcceptNumberOrString(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		new  func() any
		get  func(any) assistantID
	}{
		{"article", `{"articleId":12}`, func() any { return &articleIDInput{} }, func(v any) assistantID { return v.(*articleIDInput).ArticleID }},
		{"config", `{"configId":"12"}`, func() any { return &configIDInput{} }, func(v any) assistantID { return v.(*configIDInput).ConfigID }},
		{"knowledge", `{"knowledgeBaseId":12,"articleId":"13"}`, func() any { return &readKnowledgeNodeInput{} }, func(v any) assistantID { return *v.(*readKnowledgeNodeInput).KnowledgeBaseID }},
		{"document", `{"knowledgeBaseId":1,"documentId":12}`, func() any { return &readKnowledgeNodeInput{} }, func(v any) assistantID { return *v.(*readKnowledgeNodeInput).DocumentID }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := test.new()
			if err := json.Unmarshal([]byte(test.raw), value); err != nil {
				t.Fatal(err)
			}
			if test.get(value) != assistantID("12") {
				t.Fatalf("decoded id = %q", test.get(value))
			}
		})
	}
}

func TestAssistantOptionalNumericInputsPreserveExplicitZero(t *testing.T) {
	var knowledge searchKnowledgeInput
	if err := json.Unmarshal([]byte(`{"query":"x","limit":0}`), &knowledge); err != nil {
		t.Fatal(err)
	}
	if knowledge.Limit == nil || *knowledge.Limit != 0 {
		t.Fatalf("knowledge limit = %#v", knowledge.Limit)
	}
	var document readKnowledgeNodeInput
	if err := json.Unmarshal([]byte(`{"documentId":1,"chunkIndex":0}`), &document); err != nil {
		t.Fatal(err)
	}
	if document.ChunkIndex == nil || *document.ChunkIndex != 0 {
		t.Fatalf("document chunkIndex = %#v", document.ChunkIndex)
	}
}

func TestResolveRequestedChatModelIDRejectsConflicts(t *testing.T) {
	model := assistantID("11")
	config := assistantID("12")
	if _, err := resolveRequestedChatModelID(&model, &config); err == nil {
		t.Fatal("expected conflicting modelId/configId to be rejected")
	}
	config = assistantID("11")
	id, err := resolveRequestedChatModelID(&model, &config)
	if err != nil || id == nil || *id != 11 {
		t.Fatalf("unexpected result: id=%v err=%v", id, err)
	}
}

func TestChunkTextByRunesKeepsUTF8Valid(t *testing.T) {
	text := "你好，Petrichor🌧️世界"
	chunks := chunkTextByRunes(text, 3)
	if strings.Join(chunks, "") != text {
		t.Fatalf("chunks did not reconstruct original text: %#v", chunks)
	}
	for _, chunk := range chunks {
		if !utf8.ValidString(chunk) {
			t.Fatalf("invalid UTF-8 chunk: %q", chunk)
		}
	}
}

func TestChatMessagePersistedValueKeepsFullUIMessage(t *testing.T) {
	var message chatUIMessage
	raw := `{"id":"client-1","role":"user","parts":[{"type":"text","text":"hello"}],"metadata":{"source":"composer"}}`
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatal(err)
	}
	value, ok := chatMessagePersistedValue(message).(map[string]any)
	if !ok {
		t.Fatalf("unexpected persisted value type: %T", chatMessagePersistedValue(message))
	}
	if value["id"] != "client-1" {
		t.Fatalf("message id was lost: %#v", value)
	}
	metadata, _ := value["metadata"].(map[string]any)
	if metadata["source"] != "composer" {
		t.Fatalf("metadata was lost: %#v", value)
	}
}

func TestFindPendingConfirmationRequiresMatchingServerTicketShape(t *testing.T) {
	build := func(inputID, resultID string) []chatUIMessage {
		raw := `[{"role":"assistant","parts":[{"type":"tool-request_user_confirmation","input":{"id":"` + inputID + `","action":{"toolName":"delete_article","input":{"articleId":"1"}}},"output":{"confirmed":true,"confirmationId":"` + resultID + `","allowForThread":true}}]}]`
		var messages []chatUIMessage
		if err := json.Unmarshal([]byte(raw), &messages); err != nil {
			t.Fatal(err)
		}
		return messages
	}
	pending := findPendingConfirmation(build("cfm-1", "cfm-1"))
	if pending == nil || pending.ConfirmationID != "cfm-1" || !pending.AllowForThread {
		t.Fatalf("valid confirmation not found: %#v", pending)
	}
	if pending := findPendingConfirmation(build("cfm-1", "cfm-2")); pending != nil {
		t.Fatalf("mismatched confirmation should be ignored: %#v", pending)
	}
}

func TestChatMessagesForModelIncludesHistoryAndToolOutcome(t *testing.T) {
	var messages []chatUIMessage
	raw := `[
		{"role":"user","parts":[{"type":"text","text":"先查文章"}]},
		{"role":"assistant","parts":[{"type":"text","text":"查到了"},{"type":"tool-search_knowledge","output":{"title":"雨"}}]},
		{"role":"user","parts":[{"type":"text","text":"继续总结"}]}
	]`
	if err := json.Unmarshal([]byte(raw), &messages); err != nil {
		t.Fatal(err)
	}
	modelMessages := chatMessagesForModel(messages)
	if len(modelMessages) != 3 {
		t.Fatalf("expected complete history, got %d messages", len(modelMessages))
	}
	if !strings.Contains(modelMessages[1].Content, "search_knowledge") || !strings.Contains(modelMessages[1].Content, "雨") {
		t.Fatalf("tool outcome missing from history: %q", modelMessages[1].Content)
	}
}

func TestRedactAssistantStepInput(t *testing.T) {
	input := map[string]any{
		"config": map[string]any{"apiKey": "secret", "name": "chat"},
		"items":  []any{map[string]any{"Authorization": "Bearer token", "value": 1}},
	}
	redacted := redactAssistantStepInput(input).(map[string]any)
	config := redacted["config"].(map[string]any)
	if config["apiKey"] != "[redacted]" || config["name"] != "chat" {
		t.Fatalf("unexpected config redaction: %#v", config)
	}
	item := redacted["items"].([]any)[0].(map[string]any)
	if item["Authorization"] != "[redacted]" {
		t.Fatalf("authorization was not redacted: %#v", item)
	}
}

func TestParseEinoChatOptionsDisablesDeepSeekThinkingForToolsByDefault(t *testing.T) {
	raw := `{"maxTokens":2048,"temperature":0.2,"deepSeekThinking":"enabled"}`
	options := parseEinoChatOptions(&raw)
	if options.MaxTokens == nil || *options.MaxTokens != 2048 {
		t.Fatalf("max tokens not parsed: %#v", options)
	}
	if options.Temperature == nil || *options.Temperature != float32(0.2) {
		t.Fatalf("temperature not parsed: %#v", options)
	}
	if options.Thinking != "enabled" || !options.DisableThinkingForTools {
		t.Fatalf("thinking options not parsed: %#v", options)
	}
}

func TestApplyOperatorMemoryMutationMatchesPatchSemantics(t *testing.T) {
	addition := "  新偏好  "
	profile, notes, errorCode := applyOperatorMemoryMutation("已有画像", "", memoryManageInput{
		Action: "add", Target: "user_profile", Text: &addition,
	})
	if errorCode != "" || profile != "已有画像\n新偏好" || notes != "" {
		t.Fatalf("unexpected add result: profile=%q notes=%q error=%q", profile, notes, errorCode)
	}

	missing := "不存在"
	replacement := "替换"
	_, _, errorCode = applyOperatorMemoryMutation(profile, notes, memoryManageInput{
		Action: "replace", Target: "user_profile", OldText: &missing, NewText: &replacement,
	})
	if errorCode != "invalid_patch" {
		t.Fatalf("missing replacement target should fail, got %q", errorCode)
	}

	tooLong := strings.Repeat("界", operatorUserProfileMaxChars+1)
	_, _, errorCode = applyOperatorMemoryMutation("", "", memoryManageInput{
		Action: "add", Target: "user_profile", Text: &tooLong,
	})
	if errorCode != "memory_limit_exceeded" {
		t.Fatalf("oversized memory should fail, got %q", errorCode)
	}
}

func TestBuiltinAssistantSkillsRestoreLegacyCatalog(t *testing.T) {
	for _, name := range []string{"knowledge-qa", "article-write", "admin-ops"} {
		skill, ok := builtinSkills[name]
		if !ok || skill.Name != name || strings.TrimSpace(skill.Instructions) == "" {
			t.Fatalf("missing builtin skill %q: %#v", name, skill)
		}
	}
}

func TestBuildUnifiedDiffMatchesLegacyPreviewShape(t *testing.T) {
	diff := buildUnifiedDiff("第一行\r\n旧内容", "第一行\n新内容", "content.md")
	for _, expected := range []string{"--- a/content.md", "+++ b/content.md", "@@ line 2 @@", "-旧内容", "+新内容"} {
		if !strings.Contains(diff, expected) {
			t.Fatalf("diff missing %q: %s", expected, diff)
		}
	}
	if unchanged := buildUnifiedDiff("相同", "相同", "content.md"); !strings.Contains(unchanged, "@@ unchanged @@") {
		t.Fatalf("unchanged marker missing: %s", unchanged)
	}
}

func TestAssistantMoveNodeOrderClampsIndexAndDeduplicates(t *testing.T) {
	index := 99
	got := assistantMoveNodeOrder([]int64{1, 2, 3}, 2, &index)
	want := []int64{1, 3, 2}
	if len(got) != len(want) {
		t.Fatalf("unexpected order: %#v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected order: got=%#v want=%#v", got, want)
		}
	}
}

func TestAssistantSearchScorePrefersTitleAndExactQuery(t *testing.T) {
	titleScore := assistantSearchScore("春雨札记", "", "", "春雨")
	contentScore := assistantSearchScore("", "", "正文提到了春雨", "春雨")
	if titleScore <= contentScore {
		t.Fatalf("title match should rank above content: title=%d content=%d", titleScore, contentScore)
	}
	if assistantSearchScore("晴天", "", "", "春雨") != 0 {
		t.Fatal("unrelated content should not match")
	}
}

func TestAssistantIsDescendantDetectsCyclesSafely(t *testing.T) {
	one, two := int64(1), int64(2)
	nodes := []*ent.KBNode{
		{ID: 1, ParentID: &two},
		{ID: 2, ParentID: &one},
	}
	if !assistantIsDescendant(nodes, 1, &two) {
		t.Fatal("expected node 2 to be a descendant of node 1")
	}
	missing := int64(3)
	if assistantIsDescendant(nodes, 1, &missing) {
		t.Fatal("missing node must not be treated as descendant")
	}
}

func TestMergeOperatorHistoryHitsPrefersSemanticAndDeduplicates(t *testing.T) {
	semantic := []map[string]any{{"threadId": "1", "messageId": "2", "source": "semantic"}}
	keyword := []map[string]any{
		{"threadId": "1", "messageId": "2", "source": "keyword"},
		{"threadId": "3", "messageId": "4", "source": "keyword"},
	}
	merged := mergeOperatorHistoryHits(semantic, keyword, 2)
	if len(merged) != 2 || merged[0]["source"] != "semantic" || merged[1]["messageId"] != "4" {
		t.Fatalf("unexpected merged hits: %#v", merged)
	}
}
