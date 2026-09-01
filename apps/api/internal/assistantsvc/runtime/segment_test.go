package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/schema"

	aicore "petrichor/api/internal/aicore"
)

func TestToEinoInputPreservesHistoricalToolConversation(t *testing.T) {
	request := &SegmentRequest{
		Instructions: "system",
		Messages: []map[string]any{
			{"role": "assistant", "content": "", "toolCalls": []map[string]any{{"id": "call-1", "name": "lookup", "argsJSON": `{"q":"x"}`}}},
			{"role": "tool", "content": `{"ok":true}`, "toolCallId": "call-1", "toolName": "lookup"},
		},
	}
	got := toEinoInput(request)
	if len(got) != 3 {
		t.Fatalf("unexpected message count: %#v", got)
	}
	if len(got[1].ToolCalls) != 1 || got[1].ToolCalls[0].ID != "call-1" || got[1].ToolCalls[0].Function.Name != "lookup" {
		t.Fatalf("assistant tool call was lost: %#v", got[1])
	}
	if got[2].Role != schema.Tool || got[2].ToolCallID != "call-1" || got[2].ToolName != "lookup" {
		t.Fatalf("tool result was lost: %#v", got[2])
	}
}

func TestRunAgentSegmentStreamsFinalAnswerThroughEino(t *testing.T) {
	server := newOpenAIStreamServer(t, func(call int, request map[string]any) []string {
		if call != 1 {
			t.Fatalf("unexpected model call: %d", call)
		}
		if temperature, ok := request["temperature"].(float64); !ok || temperature != 0.2 {
			t.Fatalf("temperature 精度被 float32 污染: %#v", request["temperature"])
		}
		return []string{
			`{"choices":[{"delta":{"content":"你"}}]}`,
			`{"choices":[{"delta":{"content":"好"}}]}`,
			`{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}`,
		}
	})
	defer server.Close()

	deltas := []string{}
	result, err := RunAgentSegment(context.Background(), &SegmentRequest{
		AgentID:      "test-direct",
		Model:        testResolvedModel(server.URL),
		Instructions: "直接回答",
		Prompt:       "你好",
		MaxSteps:     1,
		OnTextDelta:  func(delta string) { deltas = append(deltas, delta) },
	}, NewSegmentController())
	if err != nil {
		t.Fatalf("RunAgentSegment error: %v", err)
	}
	if result.Text != "你好" {
		t.Fatalf("want final text 你好, got %q", result.Text)
	}
	if strings.Join(deltas, "") != "你好" {
		t.Fatalf("unexpected deltas: %#v", deltas)
	}
	// 无工具的段每个字都是答案：必须逐块直发，不能为了防旁白攒着不发。
	if len(deltas) != 2 {
		t.Fatalf("tool-less segment must stream every delta live: %#v", deltas)
	}
	if result.Usage.Input != 7 || result.Usage.Output != 2 || result.Usage.Total != 9 {
		t.Fatalf("unexpected usage: %+v", result.Usage)
	}
}

func TestCleanFloat32UsesShortestDecimalRepresentation(t *testing.T) {
	for input, want := range map[float32]float64{
		0.2:   0.2,
		0.4:   0.4,
		0.123: 0.123,
	} {
		if got := cleanFloat32(input); got != want {
			t.Fatalf("cleanFloat32(%v)=%v want=%v", input, got, want)
		}
	}
}

func TestRunAgentSegmentUsesEinoToolLoopAndDropsNarration(t *testing.T) {
	server := newOpenAIStreamServer(t, func(call int, request map[string]any) []string {
		switch call {
		case 1:
			if len(request["tools"].([]any)) != 1 {
				t.Fatalf("tool schema not sent: %#v", request["tools"])
			}
			return []string{
				`{"choices":[{"delta":{"content":"我先查一下。"}}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"echo_tool","arguments":"{\"value\":\"x\"}"}}]}}]}`,
				`{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}`,
			}
		case 2:
			messages, _ := request["messages"].([]any)
			if len(messages) < 4 {
				t.Fatalf("tool result was not fed back to model: %#v", messages)
			}
			last, _ := messages[len(messages)-1].(map[string]any)
			if last["role"] != "tool" || last["tool_call_id"] != "call-1" {
				t.Fatalf("unexpected tool message: %#v", last)
			}
			return []string{
				`{"choices":[{"delta":{"content":"最终答案"}}]}`,
				`{"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":4}}`,
			}
		default:
			t.Fatalf("unexpected model call: %d", call)
			return nil
		}
	})
	defer server.Close()

	definition, executor, executionCtx := testEchoExecutor()
	controller := NewSegmentController()
	resetCount := 0
	deltas := []string{}
	result, err := RunAgentSegment(context.Background(), &SegmentRequest{
		AgentID:       "test-react",
		Model:         testResolvedModel(server.URL),
		Instructions:  "需要时调用工具",
		Prompt:        "查询 x",
		Tools:         []*AgentToolDefinition{definition},
		Ctx:           executionCtx,
		Executor:      executor,
		MaxSteps:      2,
		OnTextDelta:   func(delta string) { deltas = append(deltas, delta) },
		OnAnswerReset: func() { resetCount++ },
	}, controller)
	if err != nil {
		t.Fatalf("RunAgentSegment error: %v", err)
	}
	if result.Text != "最终答案" {
		t.Fatalf("narration leaked into final answer: %q", result.Text)
	}
	// 旁白在本轮确认调用工具时被丢弃，从未流出，因此前端也不需要换段。
	if result.ToolCallCount != 1 || resetCount != 0 {
		t.Fatalf("unexpected tool/reset count: tool=%d reset=%d", result.ToolCallCount, resetCount)
	}
	if strings.Join(deltas, "") != "最终答案" {
		t.Fatalf("narration must never reach the stream: %#v", deltas)
	}
	if result.Usage.Input != 25 || result.Usage.Output != 8 {
		t.Fatalf("usage should aggregate model rounds: %+v", result.Usage)
	}
}

func TestRunAgentSegmentReleasesOverlongNarrationAndAsksForReset(t *testing.T) {
	narration := strings.Repeat("越", answerHoldRunes+10)
	server := newOpenAIStreamServer(t, func(call int, request map[string]any) []string {
		switch call {
		case 1:
			return []string{
				`{"choices":[{"delta":{"content":"` + narration + `"}}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"echo_tool","arguments":"{\"value\":\"x\"}"}}]}}]}`,
				`{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}`,
			}
		case 2:
			return []string{
				`{"choices":[{"delta":{"content":"最终答案"}}]}`,
				`{"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":4}}`,
			}
		default:
			t.Fatalf("unexpected model call: %d", call)
			return nil
		}
	})
	defer server.Close()

	definition, executor, executionCtx := testEchoExecutor()
	resetCount := 0
	deltas := []string{}
	result, err := RunAgentSegment(context.Background(), &SegmentRequest{
		AgentID: "test-long-narration", Model: testResolvedModel(server.URL),
		Instructions: "需要时调用工具", Prompt: "查询 x",
		Tools: []*AgentToolDefinition{definition}, Ctx: executionCtx, Executor: executor,
		MaxSteps:      2,
		OnTextDelta:   func(delta string) { deltas = append(deltas, delta) },
		OnAnswerReset: func() { resetCount++ },
	}, NewSegmentController())
	if err != nil {
		t.Fatalf("RunAgentSegment error: %v", err)
	}
	// 扣留量是防线不是保证：超长旁白仍会流出，此时必须请求前端换段丢弃它。
	if result.Text != "最终答案" || resetCount != 1 {
		t.Fatalf("unexpected text/reset: text=%q reset=%d", result.Text, resetCount)
	}
	if !strings.HasPrefix(strings.Join(deltas, ""), narration) {
		t.Fatalf("released narration should reach the stream once: %#v", deltas)
	}
}

func TestRunAgentSegmentReturnsModelError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "upstream failed", http.StatusBadGateway)
	}))
	defer server.Close()

	result, err := RunAgentSegment(context.Background(), &SegmentRequest{
		AgentID: "test-error", Model: testResolvedModel(server.URL),
		Instructions: "回答", Prompt: "问题", MaxSteps: 1,
	}, NewSegmentController())
	if err == nil {
		t.Fatalf("model error must not be swallowed, result=%+v", result)
	}
}

func TestRunAgentSegmentTreatsPolicyStopAsSegmentBoundary(t *testing.T) {
	server := newOpenAIStreamServer(t, func(call int, request map[string]any) []string {
		if call > 1 {
			t.Fatalf("stopped segment must not call model again")
		}
		return []string{
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-stop","function":{"name":"echo_tool","arguments":"{}"}}]}}]}`,
		}
	})
	defer server.Close()

	definition, executor, executionCtx := testEchoExecutor()
	controller := NewSegmentController()
	result, err := RunAgentSegment(context.Background(), &SegmentRequest{
		AgentID: "test-stop", Model: testResolvedModel(server.URL),
		Instructions: "调用工具", Prompt: "继续", Tools: []*AgentToolDefinition{definition},
		Ctx: executionCtx, Executor: executor, MaxSteps: 2,
		OnToolOutcome: func(*ToolRunOutcome) { controller.Request("stop_policy:enough_evidence") },
	}, controller)
	if err != nil {
		t.Fatalf("policy stop is not a fatal error: %v", err)
	}
	if result.Stopped == nil || result.Stopped.Reason != "stop_policy:enough_evidence" {
		t.Fatalf("unexpected stop signal: %+v", result.Stopped)
	}
	if result.ToolCallCount != 1 {
		t.Fatalf("tool execution should be recorded before stopping: %+v", result)
	}
}

func newOpenAIStreamServer(t *testing.T, respond func(call int, request map[string]any) []string) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range respond(int(calls.Add(1)), payload) {
			_, _ = fmt.Fprintf(writer, "data: %s\n\n", frame)
		}
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
}

func testResolvedModel(baseURL string) *ResolvedModelHandle {
	temperature := 0.2
	return &ResolvedModelHandle{
		Runtime: aicore.RuntimeConfig{ProviderKey: "openai-compatible", BaseURL: baseURL},
		ModelID: "test-model",
		Options: aicore.GenerationOptions{Temperature: &temperature},
	}
}

func testEchoExecutor() (*AgentToolDefinition, *ToolExecutor, *ToolExecutionContext) {
	definition := &AgentToolDefinition{
		ID: "test.echo", Name: "echo_tool", Namespace: NamespaceSystem,
		Description: "返回输入", InputSchema: json.RawMessage(`{"type":"object","properties":{"value":{"type":"string"}}}`),
		RiskLevel: RiskLow, Core: true, TimeoutMs: 2_000,
		Execute: func(_ *ToolExecutionContext, input any) (any, error) { return input, nil },
		Normalize: func(output any, input any) ToolNormalizerResult {
			return ToolNormalizerResult{Summary: "echo completed", Data: mustJSON(output)}
		},
	}
	registry := NewToolRegistry()
	registry.Register(definition)
	state := NewAgentStateStore("run-test", "conversation-test", "1", "goal", ComplexitySimple, nowMs())
	observations := NewObservationStore()
	evidence := NewEvidenceStore()
	trace := NewTraceCollector("run-test", "conversation-test", "1", "test-model", nowMs())
	events := NewAgentEventEmitter("run-test", nil)
	executor := NewToolExecutor(&ToolExecutorDeps{
		Registry: registry,
		Permissions: NewDefaultPermissionResolver(func(toolID string) *AgentToolDefinition {
			return registry.Get(toolID)
		}),
		Observations: observations, Evidence: evidence, State: state, Trace: trace,
		LoopDetector: NewLoopDetector(4), Events: events,
	})
	executionCtx := &ToolExecutionContext{
		RunID: "run-test", UserID: 1, ConversationID: "conversation-test",
		SystemRole: "USER", State: state.Current(),
	}
	return definition, executor, executionCtx
}
