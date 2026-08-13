package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const EmbeddingDimensions = 1024

// ResolveEmbeddingConfig 解析用户默认 EMBEDDING 模型配置。
func ResolveEmbeddingConfig(ctx context.Context, client *ent.Client, userID int64, configID *int64) (*ent.AIModelConfig, error) {
	if configID != nil && *configID > 0 {
		row, err := client.AIModelConfig.Query().
			Where(aimodelconfig.IDEQ(*configID), aimodelconfig.UserIDEQ(userID)).
			Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return nil, response.NotFound("EMBEDDING 配置不存在")
			}
			return nil, err
		}
		if row.ConfigType != "EMBEDDING" {
			return nil, response.BadRequest("配置类型不是 EMBEDDING")
		}
		if !row.Enabled {
			return nil, response.BadRequest("EMBEDDING 配置未启用")
		}
		return row, nil
	}

	row, err := client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(userID),
			aimodelconfig.ConfigTypeEQ("EMBEDDING"),
			aimodelconfig.IsDefaultEQ(true),
			aimodelconfig.EnabledEQ(true),
		).
		Order(ent.Asc(aimodelconfig.FieldID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.BadRequest("未找到可用的默认配置：EMBEDDING")
		}
		return nil, err
	}
	return row, nil
}

// HasEmbeddingConfig 检查用户是否已配置启用的默认 EMBEDDING 模型。
func HasEmbeddingConfig(ctx context.Context, client *ent.Client, userID int64) (bool, error) {
	return client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(userID),
			aimodelconfig.ConfigTypeEQ("EMBEDDING"),
			aimodelconfig.IsDefaultEQ(true),
			aimodelconfig.EnabledEQ(true),
		).
		Exist(ctx)
}

// Embed 调用 OpenAI 兼容 /embeddings 接口，批量生成向量。
func (g *Generation) Embed(ctx context.Context, modelCfg *ent.AIModelConfig, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	apiKey, err := g.ResolveAPIKey(modelCfg)
	if err != nil {
		return nil, err
	}
	baseURL := "https://api.openai.com/v1"
	if modelCfg.BaseURL != nil && strings.TrimSpace(*modelCfg.BaseURL) != "" {
		baseURL = strings.TrimRight(strings.TrimSpace(*modelCfg.BaseURL), "/")
	}
	endpoint := baseURL + "/embeddings"
	body := map[string]any{
		"model": modelCfg.Model,
		"input": texts,
	}
	payload, _ := json.Marshal(body)
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
		return nil, fmt.Errorf("向量模型调用失败(%d): %s", resp.StatusCode, truncate(string(raw), 400))
	}
	var parsed struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
			Index     int       `json:"index"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	out := make([][]float32, len(texts))
	for _, item := range parsed.Data {
		if item.Index < 0 || item.Index >= len(out) {
			continue
		}
		vec := make([]float32, len(item.Embedding))
		for i, v := range item.Embedding {
			vec[i] = float32(v)
		}
		out[item.Index] = vec
	}
	for i, vec := range out {
		if vec == nil {
			return nil, fmt.Errorf("向量模型返回缺少第 %d 条结果", i)
		}
	}
	return out, nil
}
