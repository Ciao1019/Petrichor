package aicore

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestVertexBaseURLMatchesAISDKRouting(t *testing.T) {
	t.Parallel()
	tests := []struct {
		location string
		want     string
	}{
		{"us-central1", "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/publishers/google"},
		{"global", "https://aiplatform.googleapis.com/v1beta1/projects/demo/locations/global/publishers/google"},
		{"eu", "https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/demo/locations/eu/publishers/google"},
	}
	for _, tt := range tests {
		t.Run(tt.location, func(t *testing.T) {
			t.Parallel()
			got, err := vertexBaseURL(RuntimeConfig{ProviderKey: "google-vertex", Extra: map[string]string{
				"project": "demo", "location": tt.location,
			}})
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("base url = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestVertexOAuthToolStreamAndEmbeddings(t *testing.T) {
	t.Parallel()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}))
	var tokenCalls atomic.Int32

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			tokenCalls.Add(1)
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				t.Fatalf("grant_type = %q", r.Form.Get("grant_type"))
			}
			verifyVertexAssertion(t, r.Form.Get("assertion"), &privateKey.PublicKey, "svc@example.test", server.URL+"/token")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"vertex-access","expires_in":3600,"token_type":"Bearer"}`))
		case "/models/gemini-test:streamGenerateContent":
			if r.URL.Query().Get("alt") != "sse" || r.Header.Get("Authorization") != "Bearer vertex-access" || r.Header.Get("X-Vertex") != "yes" {
				t.Fatalf("url/headers = %s %#v", r.URL.String(), r.Header)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			tools, _ := body["tools"].([]any)
			if len(tools) != 1 || body["systemInstruction"] == nil {
				t.Fatalf("body = %#v", body)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"先查\"}]}}],\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":2}}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"search_knowledge\",\"args\":{\"query\":\"Vertex\"}}}]}}],\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":6}}\n\n")
		case "/models/text-embedding-005:predict":
			if r.Header.Get("Authorization") != "Bearer vertex-access" {
				t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
			}
			var body struct {
				Instances []map[string]string `json:"instances"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body.Instances) != 2 || body.Instances[1]["content"] != "b" {
				t.Fatalf("body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"predictions":[{"embeddings":{"values":[1,2],"statistics":{"token_count":1}}},{"embeddings":{"values":[3,4],"statistics":{"token_count":1}}}]}`))
		default:
			t.Fatalf("unexpected request: %s", r.URL.String())
		}
	}))
	defer server.Close()

	rt := RuntimeConfig{
		ProviderKey: "google-vertex", BaseURL: server.URL, Headers: map[string]string{"X-Vertex": "yes"},
		Extra: map[string]string{
			"project": "demo", "location": "us-central1", "clientEmail": "svc@example.test",
			"privateKey": privatePEM, "tokenURL": server.URL + "/token",
		},
	}
	var deltas strings.Builder
	result, err := ChatWithTools(context.Background(), rt, "gemini-test", []ChatMessage{
		{Role: "system", Content: "系统指令"}, {Role: "user", Content: "问题"},
	}, GenerationOptions{}, nativeToolTestDefinitions, func(delta string) error {
		deltas.WriteString(delta)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Answer != "先查" || deltas.String() != result.Answer || result.InputTokens != 12 || result.OutputTokens != 6 {
		t.Fatalf("result = %#v, deltas = %q", result, deltas.String())
	}
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].Name != "search_knowledge" || result.ToolCalls[0].ArgsJSON != `{"query":"Vertex"}` {
		t.Fatalf("tool calls = %#v", result.ToolCalls)
	}
	embeddings, err := Embeddings(context.Background(), rt, "text-embedding-005", []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(embeddings) != "[[1 2] [3 4]]" {
		t.Fatalf("embeddings = %#v", embeddings)
	}
	if tokenCalls.Load() != 1 {
		t.Fatalf("token calls = %d, want cached single call", tokenCalls.Load())
	}
}

func TestVertexRejectsInvalidPrivateKey(t *testing.T) {
	t.Parallel()
	_, err := Chat(context.Background(), RuntimeConfig{
		ProviderKey: "google-vertex", BaseURL: "https://vertex.example.test",
		Extra: map[string]string{
			"project": "demo", "location": "us-central1", "clientEmail": "svc@example.test", "privateKey": "not pem",
		},
	}, "gemini-test", []ChatMessage{{Role: "user", Content: "问题"}}, GenerationOptions{})
	if err == nil || !strings.Contains(err.Error(), "PEM") {
		t.Fatalf("error = %v", err)
	}
}

func verifyVertexAssertion(t *testing.T, assertion string, publicKey *rsa.PublicKey, issuer, audience string) {
	t.Helper()
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt parts = %d", len(parts))
	}
	decode := func(value string) []byte {
		decoded, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			t.Fatal(err)
		}
		return decoded
	}
	var claims map[string]any
	if err := json.Unmarshal(decode(parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims["iss"] != issuer || claims["aud"] != audience || claims["scope"] != vertexOAuthScope {
		t.Fatalf("claims = %#v", claims)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], decode(parts[2])); err != nil {
		t.Fatalf("signature: %v", err)
	}
	if _, err := url.ParseRequestURI(claims["aud"].(string)); err != nil {
		t.Fatalf("audience: %v", err)
	}
}
