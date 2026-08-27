package aicore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var nativeToolTestDefinitions = []ToolDefinition{{
	Name: "search_knowledge", Description: "检索知识库",
	Parameters: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`),
}}

func TestAnthropicChatWithToolsStream(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/messages" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("x-api-key"); got != "test-key" {
			t.Fatalf("x-api-key = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["stream"] != true {
			t.Fatalf("stream = %#v", body["stream"])
		}
		tools, _ := body["tools"].([]any)
		if len(tools) != 1 {
			t.Fatalf("tools = %#v", body["tools"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":0}}}\n\n"))
		_, _ = w.Write([]byte("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"我先检索\"}}\n\n"))
		_, _ = w.Write([]byte("data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"search_knowledge\",\"input\":{}}}\n\n"))
		_, _ = w.Write([]byte("data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"Eino\\\"}\"}}\n\n"))
		_, _ = w.Write([]byte("data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n"))
	}))
	defer server.Close()

	var deltas strings.Builder
	result, err := ChatWithTools(context.Background(), RuntimeConfig{
		ProviderKey: "anthropic", BaseURL: server.URL, APIKey: "test-key",
	}, "claude-test", []ChatMessage{
		{Role: "system", Content: "系统指令"},
		{Role: "user", Content: "请查 Eino"},
	}, GenerationOptions{}, nativeToolTestDefinitions, func(delta string) error {
		deltas.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "我先检索" || deltas.String() != result.Answer {
		t.Fatalf("answer = %q, deltas = %q", result.Answer, deltas.String())
	}
	if result.InputTokens != 11 || result.OutputTokens != 7 {
		t.Fatalf("usage = %d/%d", result.InputTokens, result.OutputTokens)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "toolu_1" || result.ToolCalls[0].Name != "search_knowledge" || result.ToolCalls[0].ArgsJSON != `{"query":"Eino"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
}

func TestAnthropicChatWithToolsOnceCarriesToolResult(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []map[string]any `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Messages) != 3 {
			t.Fatalf("messages = %#v", body.Messages)
		}
		last := body.Messages[2]
		content, _ := last["content"].([]any)
		block, _ := content[0].(map[string]any)
		if last["role"] != "user" || len(content) != 1 || block["type"] != "tool_result" || block["tool_use_id"] != "toolu_1" {
			t.Fatalf("tool result message = %#v", last)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"最终答案"}],"usage":{"input_tokens":20,"output_tokens":4}}`))
	}))
	defer server.Close()

	result, err := ChatWithToolsOnce(context.Background(), RuntimeConfig{
		ProviderKey: "anthropic", BaseURL: server.URL, APIKey: "test-key",
	}, "claude-test", []ChatMessage{
		{Role: "user", Content: "查资料"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "toolu_1", Name: "search_knowledge", ArgsJSON: `{"query":"Eino"}`}}},
		{Role: "tool", ToolCallID: "toolu_1", Content: `{"ok":true}`},
	}, GenerationOptions{}, nativeToolTestDefinitions)
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "最终答案" || result.InputTokens != 20 || result.OutputTokens != 4 {
		t.Fatalf("result = %#v", result)
	}
}

func TestGoogleChatWithToolsOnceAndFunctionResponse(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/models/gemini-test:generateContent") {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("key") != "test-key" {
			t.Fatalf("query = %s", r.URL.RawQuery)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		tools, _ := body["tools"].([]any)
		if len(tools) != 1 {
			t.Fatalf("tools = %#v", body["tools"])
		}
		contents, _ := body["contents"].([]any)
		last, _ := contents[len(contents)-1].(map[string]any)
		parts, _ := last["parts"].([]any)
		part, _ := parts[0].(map[string]any)
		response, _ := part["functionResponse"].(map[string]any)
		if response["name"] != "search_knowledge" {
			t.Fatalf("functionResponse = %#v", response)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"functionCall":{"name":"search_knowledge","args":{"query":"Eino"}}}]}}],"usageMetadata":{"promptTokenCount":13,"candidatesTokenCount":3}}`))
	}))
	defer server.Close()

	result, err := ChatWithToolsOnce(context.Background(), RuntimeConfig{
		ProviderKey: "google", BaseURL: server.URL, APIKey: "test-key",
	}, "gemini-test", []ChatMessage{
		{Role: "user", Content: "查资料"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "gemini-call-0-search_knowledge", Name: "search_knowledge", ArgsJSON: `{"query":"旧问题"}`}}},
		{Role: "tool", ToolCallID: "gemini-call-0-search_knowledge", Content: `{"ok":true}`},
	}, GenerationOptions{}, nativeToolTestDefinitions)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].Name != "search_knowledge" || result.ToolCalls[0].ArgsJSON != `{"query":"Eino"}` {
		t.Fatalf("result = %#v", result)
	}
	if result.InputTokens != 13 || result.OutputTokens != 3 {
		t.Fatalf("usage = %d/%d", result.InputTokens, result.OutputTokens)
	}
}
