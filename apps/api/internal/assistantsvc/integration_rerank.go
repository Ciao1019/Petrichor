package assistantsvc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"time"

	"petrichor/api/internal/config"
)

// 接受 Jina /v1/rerank 兼容协议；只发送完成用户资源权限过滤后的候选。
func rerankKnowledgeWithModel(ctx context.Context, cfg config.AgentRerankConfig, query string, hits []chunkHit) ([]chunkHit, error) {
	if len(hits) < 2 {
		return hits, nil
	}
	documents := make([]string, len(hits))
	for i, hit := range hits {
		documents[i] = truncateRunes(hit.Title+"\n"+hit.Path+"\n"+hit.Snippet+"\n"+hit.Content, 6000)
	}
	body, err := json.Marshal(map[string]any{"model": cfg.Model, "query": query, "documents": documents, "top_n": len(hits), "return_documents": false})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(cfg.TimeoutSeconds)*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("重排地址无效")
	}
	request.Header.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("重排服务连接失败或超时")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("重排服务返回 HTTP %d", response.StatusCode)
	}
	var result struct {
		Results []struct {
			Index *int     `json:"index"`
			Score *float64 `json:"relevance_score"`
		} `json:"results"`
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, &result) != nil {
		return nil, errors.New("重排响应无效")
	}
	if len(result.Results) != len(hits) {
		return nil, errors.New("重排结果未覆盖全部候选")
	}
	seen := map[int]bool{}
	out := make([]chunkHit, 0, len(hits))
	for _, item := range result.Results {
		if item.Index == nil || item.Score == nil || *item.Index < 0 || *item.Index >= len(hits) || seen[*item.Index] || math.IsNaN(*item.Score) || math.IsInf(*item.Score, 0) {
			return nil, errors.New("重排索引或分数无效")
		}
		seen[*item.Index] = true
		hit := hits[*item.Index]
		hit.RerankScore = floatPtr(*item.Score)
		out = append(out, hit)
	}
	sort.SliceStable(out, func(i, j int) bool { return *out[i].RerankScore > *out[j].RerankScore })
	return out, nil
}

func rerankKnowledge(ctx context.Context, query string, hits []chunkHit, diagnostics *knowledgeRecallDiagnostics) []chunkHit {
	if len(hits) < 2 {
		diagnostics.RerankStrategy = "skipped"
		return hits
	}
	cfg := config.Get().Agent.Integrations.Rerank
	if cfg.Enabled {
		result, err := rerankKnowledgeWithModel(ctx, cfg, query, hits)
		if err == nil {
			diagnostics.RerankStrategy = "model"
			return result
		}
		diagnostics.Degraded["rerank"] = err.Error()
	}
	diagnostics.RerankStrategy = "local"
	return rerankKnowledgeLocally(query, hits)
}
