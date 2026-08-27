package aicore

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
