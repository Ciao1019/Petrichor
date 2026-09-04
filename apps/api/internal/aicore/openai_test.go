package aicore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAIHTTPClientKeepsParallelConnectionsAlive(t *testing.T) {
	transport, ok := httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("AI HTTP transport type = %T", httpClient.Transport)
	}
	if transport.MaxIdleConns < 128 || transport.MaxIdleConnsPerHost < 64 {
		t.Fatalf("AI HTTP keep-alive pool too small: total=%d perHost=%d",
			transport.MaxIdleConns, transport.MaxIdleConnsPerHost)
	}
	if httpClient.Timeout != 30*time.Minute {
		t.Fatalf("AI HTTP timeout = %s，期望 30m", httpClient.Timeout)
	}
}

func TestOpenAIChatRequestsNativeJSONMode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body struct {
			ResponseFormat *openAIRespFormat `json:"response_format"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.ResponseFormat == nil || body.ResponseFormat.Type != "json_object" {
			t.Fatalf("response_format = %#v，期望启用 json_object", body.ResponseFormat)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`)
	}))
	defer server.Close()

	result, err := OpenAIChat(context.Background(), RuntimeConfig{
		ProviderKey: "openai-compatible", BaseURL: server.URL,
	}, "glm-test", []ChatMessage{{Role: "user", Content: "只输出 JSON"}}, GenerationOptions{JSONMode: true})
	if err != nil || result.Answer != `{"ok":true}` {
		t.Fatalf("JSON 模式调用 error=%v result=%#v", err, result)
	}
}

func TestOpenAIChatStreamCollectsAnswerWithoutDeltaCallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"完整\"}}]}\n\n")
		_, _ = fmt.Fprint(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}\n\n")
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	result, err := OpenAIChatStream(context.Background(), RuntimeConfig{
		ProviderKey: "openai-compatible", BaseURL: server.URL,
	}, "model", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, nil)
	if err != nil {
		t.Fatalf("OpenAIChatStream error: %v", err)
	}
	if result.Answer != "完整答案" {
		t.Fatalf("nil callback must not discard answer, got %q", result.Answer)
	}
}

func TestOpenAIChatStreamReturnsEmbeddedUpstreamError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(writer, `data: {"error":{"code":"model_error","message":"GLM tool message rejected"}}`+"\n\n")
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	_, err := OpenAIChatStream(context.Background(), RuntimeConfig{
		ProviderKey: "openai-compatible", BaseURL: server.URL,
	}, "glm-test", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, nil)
	if err == nil || !strings.Contains(err.Error(), "GLM tool message rejected") {
		t.Fatalf("流内 upstream error 不应被吞掉: %v", err)
	}
}

func TestOpenAIChatStreamRejectsEmptyStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer server.Close()

	_, err := OpenAIChatStream(context.Background(), RuntimeConfig{
		ProviderKey: "openai-compatible", BaseURL: server.URL,
	}, "glm-test", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, nil)
	if err == nil || !strings.Contains(err.Error(), "响应为空") {
		t.Fatalf("空流不应被当作成功: %v", err)
	}
}

func TestOpenAIToolConversationUsesNullAssistantContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body struct {
			Messages []map[string]any `json:"messages"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Messages) != 3 {
			t.Fatalf("messages = %#v", body.Messages)
		}
		assistant := body.Messages[1]
		if assistant["role"] != "assistant" || assistant["content"] != nil {
			t.Fatalf("工具调用 assistant content 应为 null: %#v", assistant)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(writer, `{"choices":[{"message":{"content":"最终答案"}}]}`)
	}))
	defer server.Close()

	result, err := OpenAIChatWithToolsOnce(context.Background(), RuntimeConfig{
		ProviderKey: "openai-compatible", BaseURL: server.URL,
	}, "glm-test", []ChatMessage{
		{Role: "user", Content: "查资料"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-1", Name: "lookup", ArgsJSON: `{}`}}},
		{Role: "tool", ToolCallID: "call-1", Content: `{"ok":true}`},
	}, GenerationOptions{}, []ToolDefinition{{Name: "lookup", Parameters: json.RawMessage(`{"type":"object"}`)}})
	if err != nil || result.Answer != "最终答案" {
		t.Fatalf("tool conversation error=%v result=%#v", err, result)
	}
}

func TestEffectiveEmbeddingBaseURLUsesCatalogDefault(t *testing.T) {
	runtime := RuntimeConfig{ProviderKey: "siliconflow"}
	if got, want := effectiveEmbeddingBaseURL(runtime), "https://api.siliconflow.cn/v1"; got != want {
		t.Fatalf("目录默认向量端点未生效: got=%q want=%q", got, want)
	}
}

func TestEffectiveEmbeddingBaseURLPrefersUserOverride(t *testing.T) {
	runtime := RuntimeConfig{ProviderKey: "siliconflow", BaseURL: "https://proxy.example/v1/"}
	if got, want := effectiveEmbeddingBaseURL(runtime), "https://proxy.example/v1"; got != want {
		t.Fatalf("用户向量端点没有覆盖目录默认值: got=%q want=%q", got, want)
	}
}

func TestEffectiveEmbeddingBaseURLRequiresCustomProviderURL(t *testing.T) {
	runtime := RuntimeConfig{ProviderKey: "openai-compatible"}
	if got := effectiveEmbeddingBaseURL(runtime); got != "" {
		t.Fatalf("自定义兼容供应商不应凭空获得默认端点: %q", got)
	}
}

func TestProviderAPIProtocolUsesConfiguredSupportedValue(t *testing.T) {
	chat := `{"apiProtocol":"chat"}`
	responses := `{"apiProtocol":"responses"}`
	invalid := `{"apiProtocol":"unknown"}`
	if providerAPIProtocol("azure", &responses) != "responses" || providerAPIProtocol("openai", &chat) != "chat" {
		t.Fatal("supported provider protocol was not preserved")
	}
	if providerAPIProtocol("azure", &invalid) != "chat" || providerAPIProtocol("anthropic", &responses) != "chat" {
		t.Fatal("unsupported protocol must fall back to chat")
	}
}
