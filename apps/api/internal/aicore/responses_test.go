package aicore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponsesProtocolRoutesNonStreamAndMapsItems(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q", got)
		}
		var body struct {
			Model           string `json:"model"`
			Stream          bool   `json:"stream"`
			MaxOutputTokens int64  `json:"max_output_tokens"`
			Input           []struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			} `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Model != "gpt-test" || body.Stream || body.MaxOutputTokens != 123 {
			t.Fatalf("body = %#v", body)
		}
		if len(body.Input) != 2 || body.Input[0].Role != "system" || body.Input[1].Role != "user" {
			t.Fatalf("input = %#v", body.Input)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"最终答案"}]}],"usage":{"input_tokens":17,"output_tokens":5}}`))
	}))
	defer server.Close()

	maxTokens := int64(123)
	result, err := Chat(context.Background(), RuntimeConfig{
		ProviderKey: "openai", BaseURL: server.URL, APIKey: "test-key", APIProtocol: "responses",
	}, "gpt-test", []ChatMessage{
		{Role: "system", Content: "系统指令"},
		{Role: "user", Content: "问题"},
	}, GenerationOptions{MaxTokens: &maxTokens})
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "最终答案" || result.InputTokens != 17 || result.OutputTokens != 5 {
		t.Fatalf("result = %#v", result)
	}
}

func TestResponsesProtocolMapsMultimodalAndToolHistory(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Input []map[string]any `json:"input"`
			Tools []map[string]any `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Input) != 4 {
			t.Fatalf("input = %#v", body.Input)
		}
		parts, _ := body.Input[0]["content"].([]any)
		textPart, _ := parts[0].(map[string]any)
		imagePart, _ := parts[1].(map[string]any)
		if textPart["type"] != "input_text" || imagePart["type"] != "input_image" || imagePart["image_url"] != "https://example.test/a.png" {
			t.Fatalf("parts = %#v", parts)
		}
		if body.Input[1]["type"] != "function_call" || body.Input[1]["call_id"] != "call_old" || body.Input[1]["name"] != "search_knowledge" {
			t.Fatalf("function call = %#v", body.Input[1])
		}
		if body.Input[2]["type"] != "function_call_output" || body.Input[2]["call_id"] != "call_old" || body.Input[2]["output"] != `{"ok":true}` {
			t.Fatalf("function output = %#v", body.Input[2])
		}
		if body.Input[3]["role"] != "user" {
			t.Fatalf("last input = %#v", body.Input[3])
		}
		if len(body.Tools) != 1 || body.Tools[0]["type"] != "function" || body.Tools[0]["name"] != "search_knowledge" || body.Tools[0]["function"] != nil {
			t.Fatalf("tools = %#v", body.Tools)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_2","status":"completed","output":[{"type":"function_call","id":"fc_new","call_id":"call_new","name":"search_knowledge","arguments":"{\"query\":\"Responses\"}"}],"usage":{"input_tokens":30,"output_tokens":8}}`))
	}))
	defer server.Close()

	result, err := ChatWithToolsOnce(context.Background(), RuntimeConfig{
		ProviderKey: "openai", BaseURL: server.URL, APIProtocol: "responses",
	}, "gpt-test", []ChatMessage{
		{Role: "user", Parts: []MediaPart{{Type: "text", Text: "看图"}, {Type: "image_url", ImageURL: "https://example.test/a.png"}}},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "call_old", Name: "search_knowledge", ArgsJSON: `{"query":"旧问题"}`}}},
		{Role: "tool", ToolCallID: "call_old", Content: `{"ok":true}`},
		{Role: "user", Content: "继续"},
	}, GenerationOptions{}, nativeToolTestDefinitions)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "call_new" || result.ToolCalls[0].Name != "search_knowledge" || result.ToolCalls[0].ArgsJSON != `{"query":"Responses"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	if !result.HasToolCalls || result.InputTokens != 30 || result.OutputTokens != 8 {
		t.Fatalf("result = %#v", result)
	}
}

func TestResponsesProtocolStreamsTextToolsUsageAndReasoning(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["stream"] != true {
			t.Fatalf("stream = %#v", body["stream"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_3\",\"status\":\"in_progress\"}}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"我先\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"检索\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"需要资料\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"fc_3\",\"call_id\":\"call_3\",\"name\":\"search_knowledge\",\"arguments\":\"\"}}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_3\",\"output_index\":1,\"delta\":\"{\\\"query\\\":\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_3\",\"output_index\":1,\"delta\":\"\\\"Eino\\\"}\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_3\",\"output_index\":1,\"arguments\":\"{\\\"query\\\":\\\"Eino\\\"}\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"fc_3\",\"call_id\":\"call_3\",\"name\":\"search_knowledge\",\"arguments\":\"{\\\"query\\\":\\\"Eino\\\"}\"}}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_3\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"我先检索\"}]},{\"type\":\"function_call\",\"id\":\"fc_3\",\"call_id\":\"call_3\",\"name\":\"search_knowledge\",\"arguments\":\"{\\\"query\\\":\\\"Eino\\\"}\"}],\"usage\":{\"input_tokens\":40,\"output_tokens\":9}}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	var deltas strings.Builder
	result, err := ChatWithTools(context.Background(), RuntimeConfig{
		ProviderKey: "xai", BaseURL: server.URL, APIProtocol: "responses",
	}, "grok-test", []ChatMessage{{Role: "user", Content: "查资料"}}, GenerationOptions{}, nativeToolTestDefinitions, func(delta string) error {
		deltas.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "我先检索" || deltas.String() != result.Answer {
		t.Fatalf("answer = %q, deltas = %q", result.Answer, deltas.String())
	}
	if result.Reasoning == nil || *result.Reasoning != "需要资料" {
		t.Fatalf("reasoning = %#v", result.Reasoning)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "call_3" || result.ToolCalls[0].ArgsJSON != `{"query":"Eino"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	if result.InputTokens != 40 || result.OutputTokens != 9 {
		t.Fatalf("usage = %d/%d", result.InputTokens, result.OutputTokens)
	}
}

func TestResponsesProtocolPropagatesStreamFailure(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"部分\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream exploded\"}}}\n\n")
	}))
	defer server.Close()

	result, err := ChatStream(context.Background(), RuntimeConfig{
		ProviderKey: "openai", BaseURL: server.URL, APIProtocol: "responses",
	}, "gpt-test", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, nil)
	if err == nil || !strings.Contains(err.Error(), "upstream exploded") {
		t.Fatalf("error = %v", err)
	}
	if result == nil || result.Answer != "部分" {
		t.Fatalf("partial result = %#v", result)
	}
}

func TestResponsesProtocolStopsWhenDeltaCallbackFails(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"文本\"}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n")
	}))
	defer server.Close()

	want := errors.New("client disconnected")
	result, err := ChatStream(context.Background(), RuntimeConfig{
		ProviderKey: "openai", BaseURL: server.URL, APIProtocol: "responses",
	}, "gpt-test", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, func(string) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("error = %v", err)
	}
	if result == nil || result.Answer != "文本" {
		t.Fatalf("partial result = %#v", result)
	}
}
