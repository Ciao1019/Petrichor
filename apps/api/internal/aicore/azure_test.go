package aicore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAzureEndpointMatchesAISDKV1Routing(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		rt   RuntimeConfig
		path string
		want string
	}{
		{
			name: "resource name default version",
			rt:   RuntimeConfig{ProviderKey: "azure", Extra: map[string]string{"resourceName": "demo"}},
			path: "/chat/completions",
			want: "https://demo.openai.azure.com/openai/v1/chat/completions?api-version=v1",
		},
		{
			name: "azure base and explicit version",
			rt: RuntimeConfig{ProviderKey: "azure", BaseURL: "https://custom.openai.azure.com/openai", Extra: map[string]string{
				"apiVersion": "2024-10-01-preview",
			}},
			path: "/responses",
			want: "https://custom.openai.azure.com/openai/v1/responses?api-version=2024-10-01-preview",
		},
		{
			name: "custom gateway owns routing",
			rt: RuntimeConfig{ProviderKey: "azure", BaseURL: "https://gateway.example.test/azure/proxy", Extra: map[string]string{
				"apiVersion": "ignored",
			}},
			path: "/embeddings",
			want: "https://gateway.example.test/azure/proxy/embeddings",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := azureEndpoint(tt.rt, tt.path)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("endpoint = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAzureChatCustomGatewayUsesAPIKeyAndDeploymentModel(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.URL.RawQuery != "" {
			t.Fatalf("url = %s", r.URL.String())
		}
		if r.Header.Get("api-key") != "azure-key" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Custom") != "value" {
			t.Fatalf("headers = %#v", r.Header)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "deployment-chat" || body["stream"] != true {
			t.Fatalf("body = %#v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Azure\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}],\"usage\":{\"prompt_tokens\":6,\"completion_tokens\":2}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	var deltas strings.Builder
	result, err := ChatStream(context.Background(), RuntimeConfig{
		ProviderKey: "azure", BaseURL: server.URL, APIKey: "azure-key", APIProtocol: "chat",
		Headers: map[string]string{"X-Custom": "value"}, Extra: map[string]string{"resourceName": "ignored"},
	}, "deployment-chat", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{}, func(delta string) error {
		deltas.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "Azure答案" || deltas.String() != result.Answer || result.InputTokens != 6 || result.OutputTokens != 2 {
		t.Fatalf("result = %#v, deltas = %q", result, deltas.String())
	}
}

func TestAzureResponsesAndEmbeddingsCustomGateway(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("api-key") != "azure-key" || r.Header.Get("Authorization") != "" {
			t.Fatalf("headers = %#v", r.Header)
		}
		switch r.URL.Path {
		case "/responses":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["model"] != "deployment-responses" {
				t.Fatalf("body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Responses OK"}]}],"usage":{"input_tokens":8,"output_tokens":3}}`))
		case "/embeddings":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["model"] != "deployment-embedding" {
				t.Fatalf("body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"data":[{"index":1,"embedding":[3,4]},{"index":0,"embedding":[1,2]}]}`))
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	rt := RuntimeConfig{ProviderKey: "azure", BaseURL: server.URL, APIKey: "azure-key", APIProtocol: "responses"}
	chat, err := Chat(context.Background(), rt, "deployment-responses", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if chat.Answer != "Responses OK" || chat.InputTokens != 8 || chat.OutputTokens != 3 {
		t.Fatalf("chat = %#v", chat)
	}
	embeddings, err := Embeddings(context.Background(), rt, "deployment-embedding", []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(embeddings) != "[[1 2] [3 4]]" {
		t.Fatalf("embeddings = %#v", embeddings)
	}
}

func TestAzureRequiresResourceOrBaseURL(t *testing.T) {
	t.Parallel()
	_, err := Chat(context.Background(), RuntimeConfig{
		ProviderKey: "azure", APIProtocol: "chat", Extra: map[string]string{},
	}, "deployment", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{})
	if err == nil || !strings.Contains(err.Error(), "resourceName") {
		t.Fatalf("error = %v", err)
	}
}
