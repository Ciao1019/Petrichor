package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// RerankResult 是重排接口返回的原文下标和相关性分数。
type RerankResult struct {
	Index int     `json:"index"`
	Score float64 `json:"score"`
}

// ResolveRerankConfig 解析知识库绑定或用户默认的 RERANK 模型。
func ResolveRerankConfig(ctx context.Context, client *ent.Client, userID int64, configID *int64) (*ent.AIModelConfig, error) {
	if configID != nil && *configID > 0 {
		row, err := client.AIModelConfig.Query().Where(
			aimodelconfig.IDEQ(*configID), aimodelconfig.UserIDEQ(userID),
		).Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return nil, response.NotFound("RERANK 配置不存在")
			}
			return nil, err
		}
		if row.ConfigType != "RERANK" {
			return nil, response.BadRequest("配置类型不是 RERANK")
		}
		if !row.Enabled {
			return nil, response.BadRequest("RERANK 配置未启用")
		}
		return row, nil
	}
	row, err := client.AIModelConfig.Query().Where(
		aimodelconfig.UserIDEQ(userID),
		aimodelconfig.ConfigTypeEQ("RERANK"),
		aimodelconfig.IsDefaultEQ(true),
		aimodelconfig.EnabledEQ(true),
	).Order(ent.Asc(aimodelconfig.FieldID)).First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return row, nil
}

// Rerank 调用 Jina / Cohere / OpenAI-compatible rerank 接口。
func (g *Generation) Rerank(ctx context.Context, modelCfg *ent.AIModelConfig, query string, documents []string, topN int) ([]RerankResult, error) {
	if modelCfg == nil || len(documents) == 0 {
		return nil, nil
	}
	apiKey, err := g.ResolveAPIKey(modelCfg)
	if err != nil {
		return nil, err
	}
	if modelCfg.BaseURL == nil || strings.TrimSpace(*modelCfg.BaseURL) == "" {
		return nil, response.BadRequest("RERANK 配置缺少 BaseUrl")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(*modelCfg.BaseURL), "/")
	endpoint := baseURL
	if !strings.HasSuffix(strings.ToLower(endpoint), "/rerank") {
		endpoint += "/rerank"
	}
	if topN <= 0 || topN > len(documents) {
		topN = len(documents)
	}
	payload, _ := json.Marshal(map[string]any{
		"model": modelCfg.Model, "query": query, "documents": documents, "top_n": topN,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Rerank 模型调用失败(%d): %s", resp.StatusCode, truncate(string(raw), 400))
	}
	var parsed struct {
		Results []struct {
			Index          int     `json:"index"`
			RelevanceScore float64 `json:"relevance_score"`
			Score          float64 `json:"score"`
		} `json:"results"`
		Data []struct {
			Index          int     `json:"index"`
			RelevanceScore float64 `json:"relevance_score"`
			Score          float64 `json:"score"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("解析 Rerank 响应失败: %w", err)
	}
	items := parsed.Results
	if len(items) == 0 {
		items = parsed.Data
	}
	out := make([]RerankResult, 0, len(items))
	seen := make(map[int]struct{}, len(items))
	for _, item := range items {
		if item.Index < 0 || item.Index >= len(documents) {
			continue
		}
		if _, exists := seen[item.Index]; exists {
			continue
		}
		seen[item.Index] = struct{}{}
		score := item.RelevanceScore
		if score == 0 {
			score = item.Score
		}
		out = append(out, RerankResult{Index: item.Index, Score: score})
	}
	if len(out) == 0 {
		return nil, response.BadRequest("Rerank 模型未返回有效结果")
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > topN {
		out = out[:topN]
	}
	return out, nil
}
