package assistantsvc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"petrichor/api/internal/config"
)

func TestModelRerankValidatesIndexesAndPreservesSources(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		valid      bool
	}{
		{"valid", `{"results":[{"index":1,"relevance_score":0.9},{"index":0,"relevance_score":0.1}]}`, true},
		{"duplicate", `{"results":[{"index":1,"relevance_score":0.9},{"index":1,"relevance_score":0.1}]}`, false},
		{"missing", `{"results":[{"index":1,"relevance_score":0.9}]}`, false},
		{"no-score", `{"results":[{"index":1},{"index":0,"relevance_score":0.1}]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer test" {
					t.Error("缺少凭据")
				}
				var req map[string]any
				if json.NewDecoder(r.Body).Decode(&req) != nil || req["query"] != "问题" || req["model"] != "test-model" {
					t.Error("请求未携带原始问题或模型")
				}
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			hits := []chunkHit{{Title: "A", ArticleID: 1}, {Title: "B", ArticleID: 2}}
			out, err := rerankKnowledgeWithModel(context.Background(), config.AgentRerankConfig{URL: server.URL, APIKey: "test", Model: "test-model", TimeoutSeconds: 2}, "问题", hits)
			if (err == nil) != tc.valid {
				t.Fatalf("%+v %v", out, err)
			}
			if tc.valid && (out[0].ArticleID != 2 || hits[0].RerankScore != nil) {
				t.Fatal("来源或原候选被破坏")
			}
		})
	}
}
