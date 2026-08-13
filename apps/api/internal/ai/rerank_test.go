package ai_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

type rerankRoundTripper func(*http.Request) (*http.Response, error)

func (f rerankRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestRerankParsesJinaResponse(t *testing.T) {
	client := &http.Client{Transport: rerankRoundTripper(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/v1/rerank" {
			t.Fatalf("path = %s", req.URL.Path)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"results":[{"index":1,"relevance_score":0.9},{"index":0,"relevance_score":0.4}]}`)), Header: make(http.Header)}, nil
	})}
	baseURL, apiKey := "https://example.test/v1", "test-key"
	gen := ai.NewGenerationWithHTTPClient(&config.Config{}, client)
	got, err := gen.Rerank(context.Background(), &ent.AIModelConfig{ConfigType: "RERANK", BaseURL: &baseURL, APIKeyEnc: &apiKey, Model: "reranker"}, "q", []string{"a", "b"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Index != 1 || got[0].Score != 0.9 {
		t.Fatalf("unexpected result: %#v", got)
	}
}
