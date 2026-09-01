package assistantsvc

import (
	"context"
	"fmt"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

// KnowledgeSearchRequest 是完整知识召回管线对 HTTP/Agent API 暴露的稳定入参。
type KnowledgeSearchRequest struct {
	Context         context.Context
	UserID          int64
	KnowledgeBaseID *int64
	ArticleID       *int64
	Query           string
	Limit           int
	SubQueries      []string
}

// KnowledgeSearchHit 隔离内部 chunkHit，避免 API 层依赖召回实现细节。
type KnowledgeSearchHit struct {
	Kind              string
	KnowledgeBaseID   string
	KnowledgeBaseName *string
	ArticleID         *string
	ChunkID           *string
	PageKey           *string
	NodeKey           *string
	Title             string
	Summary           string
	Path              []string
	Score             float64
	RecallSources     []string
}

func optionalKnowledgeString(value any) *string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return nil
	}
	copy := text
	return &copy
}

func knowledgeFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	default:
		return 0
	}
}

func knowledgeStringList(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string{}, typed...)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return []string{}
	}
}

func knowledgeHitFromMap(item map[string]any) KnowledgeSearchHit {
	hit := KnowledgeSearchHit{
		KnowledgeBaseID:   stringValue(item["knowledgeBaseId"]),
		KnowledgeBaseName: optionalKnowledgeString(item["knowledgeBaseName"]),
		ArticleID:         optionalKnowledgeString(item["articleId"]),
		ChunkID:           optionalKnowledgeString(item["chunkId"]),
		PageKey:           optionalKnowledgeString(item["pageKey"]),
		NodeKey:           optionalKnowledgeString(item["nodeKey"]),
		Title:             stringValue(item["title"]),
		Summary:           stringValue(item["summary"]),
		Path:              knowledgeStringList(item["path"]),
		Score:             knowledgeFloat(item["score"]),
		RecallSources:     knowledgeStringList(item["recallSources"]),
	}
	switch {
	case hit.PageKey != nil:
		hit.Kind = "wiki"
	case hit.ChunkID != nil:
		hit.Kind = "chunk"
	case hit.NodeKey != nil:
		hit.Kind = "tree"
	default:
		hit.Kind = "article"
	}
	return hit
}

// SearchKnowledgeForAPI 复用助手主链路的向量/BM25/RRF/rerank/多样性检索。
func SearchKnowledgeForAPI(request KnowledgeSearchRequest) ([]KnowledgeSearchHit, error) {
	ctx := request.Context
	if ctx == nil {
		return nil, fmt.Errorf("知识检索缺少调用上下文")
	}
	focus := map[string]any{}
	input := map[string]any{
		"query": request.Query,
		"limit": request.Limit,
	}
	if request.KnowledgeBaseID != nil {
		focus["knowledgeBaseId"] = fmt.Sprintf("%d", *request.KnowledgeBaseID)
		input["knowledgeBaseId"] = fmt.Sprintf("%d", *request.KnowledgeBaseID)
	}
	if request.ArticleID != nil {
		focus["articleId"] = fmt.Sprintf("%d", *request.ArticleID)
	}
	if len(request.SubQueries) > 0 {
		input["subQueries"] = append([]string{}, request.SubQueries...)
	}
	output, err := executeKnowledgeSearchV2(&rt.ToolExecutionContext{
		Context: ctx,
		UserID:  request.UserID,
		Focus:   focus,
		State: &rt.AgentState{
			UserID:     fmt.Sprintf("%d", request.UserID),
			Complexity: rt.ComplexitySimple,
		},
	}, input)
	if err != nil {
		return nil, err
	}
	result, ok := output.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("知识召回返回了无效结果")
	}

	hits := []KnowledgeSearchHit{}
	switch items := result["hits"].(type) {
	case []map[string]any:
		for _, item := range items {
			hits = append(hits, knowledgeHitFromMap(item))
		}
	case []any:
		for _, raw := range items {
			if item, ok := raw.(map[string]any); ok {
				hits = append(hits, knowledgeHitFromMap(item))
			}
		}
	}
	return hits, nil
}
