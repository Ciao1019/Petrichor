package kb

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// QAKnowledgeBaseList POST /kb/qa/knowledge-base/list
func (h *Handler) QAKnowledgeBaseList(c *gin.Context) {
	u := auth.MustUser(c)
	rows, err := h.svc.client.KnowledgeBase.Query().
		Where(knowledgebase.UserIDEQ(u.ID)).
		Order(ent.Asc(knowledgebase.FieldName), ent.Asc(knowledgebase.FieldID)).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		item := gin.H{
			"id":   fmt.Sprintf("%d", row.ID),
			"name": row.Name,
		}
		if row.Description != nil {
			item["description"] = *row.Description
		} else {
			item["description"] = nil
		}
		out = append(out, item)
	}
	response.OK(c, gin.H{"knowledgeBases": out})
}

// QAModelInfo POST /kb/qa/model-info
func (h *Handler) QAModelInfo(c *gin.Context) {
	u := auth.MustUser(c)
	rows, err := h.svc.client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(u.ID),
			aimodelconfig.ConfigTypeEQ("CHAT"),
			aimodelconfig.EnabledEQ(true),
		).
		Order(ent.Asc(aimodelconfig.FieldID)).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}

	available := make([]gin.H, 0, len(rows))
	var defaultCfg *ent.AIModelConfig
	for _, row := range rows {
		cw := resolveModelContextWindow(row.Model, row.ExtraJSON)
		available = append(available, gin.H{
			"configId":      fmt.Sprintf("%d", row.ID),
			"modelId":       row.Model,
			"modelName":     row.Name,
			"contextWindow": cw,
			"isDefault":     row.IsDefault,
		})
		if row.IsDefault && defaultCfg == nil {
			defaultCfg = row
		}
	}
	if defaultCfg == nil && len(rows) > 0 {
		defaultCfg = rows[0]
	}
	if defaultCfg == nil {
		response.OK(c, gin.H{
			"configId":        nil,
			"modelId":         nil,
			"modelName":       nil,
			"contextWindow":   nil,
			"availableModels": available,
		})
		return
	}
	response.OK(c, gin.H{
		"configId":        fmt.Sprintf("%d", defaultCfg.ID),
		"modelId":         defaultCfg.Model,
		"modelName":       defaultCfg.Name,
		"contextWindow":   resolveModelContextWindow(defaultCfg.Model, defaultCfg.ExtraJSON),
		"availableModels": available,
	})
}

func resolveModelContextWindow(model string, extraJSON *string) int {
	if extraJSON != nil {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(*extraJSON)), &parsed); err == nil {
			for _, key := range []string{"contextWindow", "context_window"} {
				if v, ok := parsed[key]; ok {
					switch n := v.(type) {
					case float64:
						if n > 0 {
							return int(n)
						}
					case json.Number:
						if i, err := n.Int64(); err == nil && i > 0 {
							return int(i)
						}
					}
				}
			}
		}
	}
	m := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(m, "claude"):
		return 200_000
	case strings.Contains(m, "gemini-2"), strings.Contains(m, "gemini-1.5-pro"):
		return 2_000_000
	case strings.Contains(m, "gemini"):
		return 1_000_000
	case strings.Contains(m, "deepseek-v4"), strings.Contains(m, "deepseek-v5"),
		m == "deepseek-chat", strings.HasPrefix(m, "deepseek-chat-"),
		m == "deepseek-reasoner", strings.HasPrefix(m, "deepseek-reasoner-"):
		return 1_000_000
	case strings.Contains(m, "deepseek-r1"), strings.Contains(m, "deepseek-v3"):
		return 64_000
	case strings.Contains(m, "deepseek"):
		return 128_000
	case strings.Contains(m, "qwen3.6"), strings.Contains(m, "qwen-3.6"):
		return 1_000_000
	case strings.Contains(m, "qwen3"), strings.Contains(m, "qwen-3"),
		strings.Contains(m, "qwen-max"), strings.Contains(m, "qwen-plus"),
		strings.Contains(m, "qwen2.5"), strings.Contains(m, "qwen-2.5"):
		return 128_000
	case strings.Contains(m, "qwen"):
		return 32_000
	case strings.Contains(m, "glm-5"):
		return 200_000
	case strings.Contains(m, "glm-4"):
		return 128_000
	case strings.Contains(m, "moonshot-128k"), strings.Contains(m, "kimi"):
		return 128_000
	case strings.Contains(m, "moonshot"):
		return 32_000
	case strings.Contains(m, "gpt-4.1"), strings.Contains(m, "gpt-4o"),
		strings.Contains(m, "gpt-4-turbo"), strings.Contains(m, "o1"),
		strings.Contains(m, "o3"), strings.Contains(m, "o4"):
		return 128_000
	case strings.Contains(m, "gpt-3.5-turbo-16k"), strings.Contains(m, "gpt-3.5-turbo-1106"),
		strings.Contains(m, "gpt-3.5-turbo-0125"):
		return 16_385
	case strings.Contains(m, "gpt-3.5"):
		return 4_096
	case strings.Contains(m, "gpt-4"):
		return 8_192
	default:
		return 128_000
	}
}
