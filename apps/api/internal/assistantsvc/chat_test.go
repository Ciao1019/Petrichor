package assistantsvc

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func decodeSSEFrames(t *testing.T, raw string) []map[string]any {
	t.Helper()
	frames := []map[string]any{}
	for _, block := range strings.Split(strings.TrimSpace(raw), "\n\n") {
		if !strings.HasPrefix(block, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(block, "data: ")
		if payload == "[DONE]" {
			frames = append(frames, map[string]any{"type": "[DONE]"})
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(payload), &frame); err != nil {
			t.Fatalf("invalid SSE frame %q: %v", payload, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func TestSSEProtocolSequenceWithToolAndFinalAnswer(t *testing.T) {
	var stream strings.Builder
	emitter := &sseEmitter{writeFn: func(payload []byte) (int, error) { return stream.Write(payload) }}
	parts := newAssistantStreamParts()
	bridge := newAssistantEventBridge(emitter.chunk, parts)

	emitter.chunk(map[string]any{"type": "start", "messageId": "message-1"})
	bridge.onEvent(&rt.AgentStreamEvent{RunID: "run-1", Sequence: 1, Type: "agent_started", Timestamp: 1, Payload: json.RawMessage(`{}`)})
	emitAssistantToolTraceChunks(emitter, parts, rt.AgentToolTrace{
		ID: "call-1", ToolName: "search_knowledge", Input: map[string]any{"query": "问题"},
		RawOutput: map[string]any{"hits": 1}, OK: true,
	})
	bridge.onEvent(&rt.AgentStreamEvent{RunID: "run-1", Sequence: 2, Type: "final_answer_started", Timestamp: 2, Payload: json.RawMessage(`{}`)})
	bridge.onEvent(&rt.AgentStreamEvent{RunID: "run-1", Sequence: 3, Type: "final_answer_delta", Timestamp: 3, Payload: json.RawMessage(`{"delta":"答案"}`)})
	bridge.onEvent(&rt.AgentStreamEvent{RunID: "run-1", Sequence: 4, Type: "final_answer_completed", Timestamp: 4, Payload: json.RawMessage(`{"text":"答案"}`)})
	bridge.onEvent(&rt.AgentStreamEvent{RunID: "run-1", Sequence: 5, Type: "agent_completed", Timestamp: 5, Payload: json.RawMessage(`{}`)})
	emitter.chunk(map[string]any{"type": "finish"})
	emitter.done()

	frames := decodeSSEFrames(t, stream.String())
	types := make([]string, 0, len(frames))
	for _, frame := range frames {
		types = append(types, frame["type"].(string))
	}
	want := []string{
		"start", agentEventPartType,
		"tool-input-start", "tool-input-available", "tool-output-available",
		agentEventPartType, agentEventPartType,
		"text-start", "text-delta", "text-end", agentEventPartType,
		agentEventPartType, "finish", "[DONE]",
	}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("SSE sequence changed:\n got: %#v\nwant: %#v", types, want)
	}
	if frames[len(frames)-1]["type"] != "[DONE]" || frames[len(frames)-2]["type"] != "finish" {
		t.Fatalf("finish/[DONE] terminal order changed: %#v", frames[len(frames)-2:])
	}
}

func TestSSEErrorAndWriteFailurePaths(t *testing.T) {
	var stream strings.Builder
	emitter := &sseEmitter{writeFn: func(payload []byte) (int, error) { return stream.Write(payload) }}
	emitter.chunk(map[string]any{"type": "start", "messageId": "message-1"})
	emitter.errorFrame()
	emitter.chunk(map[string]any{"type": "finish"})
	emitter.done()
	frames := decodeSSEFrames(t, stream.String())
	want := []string{"start", "error", "finish", "[DONE]"}
	got := []string{}
	for _, frame := range frames {
		got = append(got, frame["type"].(string))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("runtime failure terminal sequence changed: got %#v want %#v", got, want)
	}

	failing := &sseEmitter{writeFn: func([]byte) (int, error) { return 0, errors.New("connection closed") }}
	if failing.chunk(map[string]any{"type": "start"}) {
		t.Fatal("SSE write failure must be reported to cancel the runtime")
	}
	if emitter.chunk(map[string]any{"unsupported": make(chan int)}) {
		t.Fatal("SSE marshal failure must be reported to cancel the runtime")
	}
}

func TestAssistantEventBridgeEmitsExactFinalAnswerSequence(t *testing.T) {
	parts := newAssistantStreamParts()
	chunks := []map[string]any{}
	bridge := newAssistantEventBridge(func(chunk any) bool {
		chunks = append(chunks, chunk.(map[string]any))
		return true
	}, parts)
	events := []*rt.AgentStreamEvent{
		{RunID: "run-1", Sequence: 1, Type: "final_answer_started", Timestamp: 1, Payload: json.RawMessage(`{}`)},
		{RunID: "run-1", Sequence: 2, Type: "final_answer_delta", Timestamp: 2, Payload: json.RawMessage(`{"delta":"答"}`)},
		{RunID: "run-1", Sequence: 3, Type: "final_answer_delta", Timestamp: 3, Payload: json.RawMessage(`{"delta":"案"}`)},
		// 模拟供应商完成事件没带全文，必须回退到本段 delta 缓冲。
		{RunID: "run-1", Sequence: 4, Type: "final_answer_completed", Timestamp: 4, Payload: json.RawMessage(`{}`)},
		{RunID: "run-1", Sequence: 5, Type: "agent_completed", Timestamp: 5, Payload: json.RawMessage(`{}`)},
	}
	for _, event := range events {
		if !bridge.onEvent(event) {
			t.Fatal("bridge unexpectedly stopped")
		}
	}
	types := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		types = append(types, chunk["type"].(string))
	}
	want := []string{
		agentEventPartType, agentEventPartType, agentEventPartType,
		"text-start", "text-delta", "text-end", agentEventPartType,
		agentEventPartType,
	}
	if !reflect.DeepEqual(types, want) {
		t.Fatalf("stream chunk order changed:\n got: %#v\nwant: %#v", types, want)
	}
	if chunks[4]["delta"] != "答案" {
		t.Fatalf("completed fallback did not join deltas: %#v", chunks[4])
	}
	if chunks[3]["id"] != agentAnswerTextID || chunks[5]["id"] != agentAnswerTextID {
		t.Fatalf("standard answer id changed: %#v", chunks[3:6])
	}
	persisted := parts.all()
	textCount := 0
	for _, part := range persisted {
		if part["type"] == "text" {
			textCount++
			if part["text"] != "答案" {
				t.Fatalf("persisted final text changed: %#v", part)
			}
		}
	}
	if textCount != 1 {
		t.Fatalf("final answer must persist exactly once: %#v", persisted)
	}
}

func TestPublicAgentEventKeepsContractAndSanitizesStopMessage(t *testing.T) {
	event := &rt.AgentStreamEvent{
		RunID: "run-1", Sequence: 9, Type: "agent_stopped", Timestamp: 123,
		Payload: json.RawMessage(`{"stopReason":"max_tool_calls","message":"内部预算细节","metrics":{"toolCalls":4}}`),
	}
	got := publicAgentEvent(event)
	if got["runId"] != "run-1" || got["sequence"] != 9 || got["type"] != "agent_stopped" || got["timestamp"] != int64(123) {
		t.Fatalf("event envelope changed: %#v", got)
	}
	payload, ok := got["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload must be an object: %#v", got["payload"])
	}
	if payload["stopReason"] != "max_tool_calls" {
		t.Fatalf("stopReason must remain machine-readable: %#v", payload)
	}
	if payload["message"] == "内部预算细节" || !strings.Contains(payload["message"].(string), "停止") {
		t.Fatalf("stop message was not sanitized: %#v", payload)
	}
}

func TestAssistantStreamPartsMatchesAIDataPartUpdateSemantics(t *testing.T) {
	parts := newAssistantStreamParts()
	parts.addData("run-1:1", map[string]any{"sequence": 1, "type": "agent_started"})
	parts.addData("run-1:answer-delta", map[string]any{"sequence": 2, "payload": map[string]any{"delta": "A"}})
	parts.addData("run-1:answer-delta", map[string]any{"sequence": 3, "payload": map[string]any{"delta": "B"}})
	parts.addText("AB")
	parts.addText("不能重复")
	parts.addData("run-1:4", map[string]any{"sequence": 4, "type": "final_answer_completed"})

	got := parts.all()
	if len(got) != 4 {
		t.Fatalf("same-id delta should update in place, got %d parts: %#v", len(got), got)
	}
	if got[0]["id"] != "run-1:1" || got[1]["id"] != "run-1:answer-delta" || got[2]["type"] != "text" || got[3]["id"] != "run-1:4" {
		t.Fatalf("part order differs from stream order: %#v", got)
	}
	data := got[1]["data"].(map[string]any)
	if data["sequence"] != 3 {
		t.Fatalf("delta part should keep the newest data: %#v", data)
	}
	if got[2]["text"] != "AB" {
		t.Fatalf("standard text part must contain the only final answer: %#v", got[2])
	}
}

func TestAssistantStreamPartsPersistsStandardToolTerminalState(t *testing.T) {
	parts := newAssistantStreamParts()
	parts.addTool("call-1", "request_user_confirmation", map[string]any{"id": "confirm-1"}, map[string]any{"confirmed": false})
	got := parts.all()
	if len(got) != 1 || got[0]["type"] != "tool-request_user_confirmation" || got[0]["state"] != "output-available" {
		t.Fatalf("tool terminal part contract changed: %#v", got)
	}
	if got[0]["toolCallId"] != "call-1" {
		t.Fatalf("tool call id was not persisted: %#v", got[0])
	}
}

func TestBuildAssistantPersistContentKeepsStructuredParts(t *testing.T) {
	state := &rt.AgentState{TokenUsage: rt.AgentTokenUsage{Input: 10, Output: 5, Total: 15}}
	result := &rt.RunResult{RunID: "run-1", Answer: "答案", State: state}
	parts := []map[string]any{
		{"type": agentEventPartType, "id": "run-1:1", "data": map[string]any{"type": "agent_started"}},
		{"type": "text", "text": "答案"},
	}
	raw := buildAssistantPersistContent(result, "run-1", parts, time.Now().Add(-time.Second))
	var content map[string]any
	if err := json.Unmarshal(raw, &content); err != nil {
		t.Fatalf("invalid persisted JSON: %v", err)
	}
	if content["agentRunId"] != "run-1" {
		t.Fatalf("missing agentRunId: %#v", content)
	}
	persistedParts, ok := content["parts"].([]any)
	if !ok || len(persistedParts) != 2 {
		t.Fatalf("structured parts were lost: %#v", content["parts"])
	}
	usage := content["usage"].(map[string]any)
	if usage["inputTokens"] != float64(10) || usage["outputTokens"] != float64(5) || usage["totalTokens"] != float64(15) {
		t.Fatalf("usage shape changed: %#v", usage)
	}
}

func TestUIMessagesToRuntimePreservesCompletedToolResults(t *testing.T) {
	messages := []json.RawMessage{
		json.RawMessage(`{"role":"user","parts":[{"type":"text","text":"请执行"}]}`),
		json.RawMessage(`{"role":"assistant","parts":[
			{"type":"text","text":"请确认"},
			{"type":"tool-call","toolCallId":"call-confirm","toolName":"request_user_confirmation",
			 "input":{"id":"confirm-1","risk":"dangerous"},
			 "output":{"confirmed":true,"confirmationId":"confirm-1","executionOutcome":{"ok":true,"deletedId":"7"}}}
		]}`),
	}
	got := uiMessagesToRuntime(messages)
	if len(got) != 3 {
		t.Fatalf("expected user + assistant call + tool result, got %#v", got)
	}
	if got[1]["role"] != "assistant" || got[1]["content"] != "请确认" {
		t.Fatalf("assistant message changed: %#v", got[1])
	}
	calls, ok := got[1]["toolCalls"].([]map[string]any)
	if !ok || len(calls) != 1 || calls[0]["id"] != "call-confirm" || calls[0]["name"] != "request_user_confirmation" {
		t.Fatalf("historical tool call was lost: %#v", got[1]["toolCalls"])
	}
	if got[2]["role"] != "tool" || got[2]["toolCallId"] != "call-confirm" || !strings.Contains(got[2]["content"].(string), "deletedId") {
		t.Fatalf("confirmation execution outcome was lost: %#v", got[2])
	}
}

func TestUIMessagesToRuntimeDropsIncompleteToolCall(t *testing.T) {
	messages := []json.RawMessage{json.RawMessage(`{"role":"assistant","parts":[
		{"type":"tool-search_knowledge","toolCallId":"pending","input":{"query":"x"},"state":"input-available"}
	]}`)}
	if got := uiMessagesToRuntime(messages); len(got) != 0 {
		t.Fatalf("unpaired historical tool call would make provider messages invalid: %#v", got)
	}
}

func TestResolveAssistantRecentCountHonorsBoundsAndBudget(t *testing.T) {
	messages := make([]map[string]any, 25)
	for index := range messages {
		messages[index] = map[string]any{"role": "user", "content": strings.Repeat("内容", 100)}
	}
	if got := resolveAssistantRecentCount(messages[:4], 100_000); got != 4 {
		t.Fatalf("short conversation should be kept whole, got %d", got)
	}
	if got := resolveAssistantRecentCount(messages, 100_000); got != assistantRecentMessageMax {
		t.Fatalf("large budget should honor hard max, got %d", got)
	}
	if got := resolveAssistantRecentCount(messages, 100); got != assistantRecentMessageMin {
		t.Fatalf("small budget should preserve minimum window, got %d", got)
	}
}

func TestAssistantFocusMapPreservesStringIDs(t *testing.T) {
	kb, article := "12", "34"
	got := assistantFocusMap(&assistantFocus{KnowledgeBaseID: &kb, ArticleID: &article})
	if got["knowledgeBaseId"] != "12" || got["articleId"] != "34" {
		t.Fatalf("focus was not passed through: %#v", got)
	}
	if _, exists := got["libraryId"]; exists {
		t.Fatalf("unset focus fields must stay omitted: %#v", got)
	}
}

func TestSanitizeRecallExcerptRemovesSecretsAndConfirmationOutcome(t *testing.T) {
	input := "api_key=secret-value Bearer abc.def token:xyz sk-abcdefghijkl executionOutcome={dangerous:true} 保留这句话"
	got := sanitizeRecallExcerpt(input)
	for _, leaked := range []string{"secret-value", "abc.def", "xyz", "sk-abcdefghijkl", "dangerous:true"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("recall excerpt leaked %q: %s", leaked, got)
		}
	}
}

func TestBuildAssistantBackgroundCombinesSummaryRecallAndFrozenMemory(t *testing.T) {
	memory := formatOperatorMemory(operatorMemorySnapshot{UserProfileMd: "偏好中文", AgentNotesMd: "先给结论"})
	got := buildAssistantBackground("旧目标", []assistantRecalledSnippet{{Score: 0.75, Excerpt: "相关历史"}}, memory)
	for _, expected := range []string{"旧目标", "相关度 0.75", "相关历史", operatorMemoryPromptTitle, "偏好中文", "先给结论"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("background missing %q: %s", expected, got)
		}
	}
}

func TestParseOperatorMemorySnapshotRejectsOversizedPayload(t *testing.T) {
	raw := `{"userProfileMd":"` + strings.Repeat("x", operatorUserProfileMax+1) + `","agentNotesMd":"","frozenAt":"now"}`
	if got := parseOperatorMemorySnapshot(&raw); got != nil {
		t.Fatalf("oversized memory snapshot must not enter the prompt: %+v", got)
	}
}
