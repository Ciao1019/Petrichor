// wiki-qa.go 问答页需要的辅助端点：可选知识库清单与可选语言模型清单。
package kb

import (
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ===== QA 辅助端点 =====

// QAKnowledgeBaseList 用户全部知识库（按名称排序）。
func QAKnowledgeBaseList(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		rows, err := pool().Query(c.Request.Context(),
			`SELECT id, name, description FROM petrichor_kb_knowledge_base
			 WHERE user_id = $1 ORDER BY name ASC`, user.ID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id int64
			var name string
			var description *string
			if err := rows.Scan(&id, &name, &description); err != nil {
				return nil, err
			}
			items = append(items, map[string]any{
				"id":          strconv.FormatInt(id, 10),
				"name":        name,
				"description": description,
			})
		}
		return map[string]any{"knowledgeBases": items}, nil
	})
}

// ===== qa/model-info：语言模型清单 + CHAT 绑定 =====

type availableModel struct {
	configID      string
	modelID       string
	modelName     string
	contextWindow int64
	isDefault     bool
}

// guessContextWindow 对应 provider-catalog.ts 的同名函数。
func guessContextWindow(modelID string) int64 {
	m := strings.ToLower(modelID)
	switch {
	case strings.Contains(m, "claude"):
		return 200_000
	case strings.Contains(m, "gemini-2") || strings.Contains(m, "gemini-1.5-pro"):
		return 2_000_000
	case strings.Contains(m, "gemini"):
		return 1_000_000
	case strings.Contains(m, "deepseek-v4") || strings.Contains(m, "deepseek-chat") || strings.Contains(m, "deepseek-reasoner"):
		return 1_000_000
	case strings.Contains(m, "deepseek-r1") || strings.Contains(m, "deepseek-v3"):
		return 64_000
	case strings.Contains(m, "deepseek"):
		return 128_000
	case strings.Contains(m, "qwen3.6") || strings.Contains(m, "qwen-3.6"):
		return 1_000_000
	case strings.Contains(m, "qwen"):
		return 128_000
	case strings.Contains(m, "glm-5"):
		return 200_000
	case strings.Contains(m, "glm-4"):
		return 128_000
	case strings.Contains(m, "kimi") || strings.Contains(m, "moonshot"):
		return 128_000
	case strings.Contains(m, "grok"):
		return 256_000
	case strings.Contains(m, "gpt-5") || strings.Contains(m, "gpt-4.1"):
		return 400_000
	case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4-turbo"),
		strings.HasPrefix(m, "o1"), strings.HasPrefix(m, "o3"):
		return 128_000
	case strings.Contains(m, "gpt-3.5"):
		return 16_385
	default:
		return 128_000
	}
}

// QAModelInfo 可选语言模型 + 当前默认（对应 wiki-agent-handlers.ts qaModelInfo）。
func QAModelInfo(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		q := pool()
		rows, err := q.Query(c.Request.Context(),
			`SELECT m.id, m.model_id, m.display_name, m.context_window, p.name
			 FROM petrichor_ai_model m JOIN petrichor_ai_provider p ON p.id = m.provider_id
			 WHERE m.user_id = $1 AND m.kind = 'LANGUAGE' AND m.enabled = true AND p.enabled = true
			 ORDER BY p.name ASC, m.model_id ASC`, user.ID)
		if err != nil {
			return nil, err
		}
		var models []*availableModel
		for rows.Next() {
			var id int64
			var modelID string
			var displayName *string
			var contextWindow *int32
			var providerName string
			if err := rows.Scan(&id, &modelID, &displayName, &contextWindow, &providerName); err != nil {
				rows.Close()
				return nil, err
			}
			window := guessContextWindow(modelID)
			if contextWindow != nil && *contextWindow > 0 {
				window = int64(*contextWindow)
			}
			// 对齐 TS：displayName 为 NULL 时兜底「供应商名 · 模型ID」
			name := ""
			if displayName != nil {
				name = *displayName
			} else {
				name = providerName + " · " + modelID
			}
			models = append(models, &availableModel{
				configID:      strconv.FormatInt(id, 10),
				modelID:       modelID,
				modelName:     name,
				contextWindow: window,
			})
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if models == nil {
			models = []*availableModel{}
		}

		var bindingModelRefID *int64
		var refID int64
		err = q.QueryRow(c.Request.Context(),
			`SELECT model_ref_id FROM petrichor_ai_binding WHERE user_id = $1 AND purpose = 'CHAT' LIMIT 1`,
			user.ID).Scan(&refID)
		if err == nil {
			bindingModelRefID = &refID
		} else if err.Error() != "no rows in result set" && !strings.Contains(err.Error(), "no rows") {
			// pgx ErrNoRows 判定放行
			if !isNoRows(err) {
				return nil, err
			}
		}

		var current *availableModel
		if bindingModelRefID != nil {
			refStr := strconv.FormatInt(*bindingModelRefID, 10)
			for _, m := range models {
				if m.configID == refStr {
					current = m
					break
				}
			}
		}
		fallback := current
		if fallback == nil && len(models) > 0 {
			fallback = models[0]
		}
		if fallback == nil {
			return map[string]any{
				"modelId": nil, "modelName": nil, "contextWindow": nil,
				"configId": nil, "availableModels": []map[string]any{},
			}, nil
		}
		list := make([]map[string]any, 0, len(models))
		for _, m := range models {
			list = append(list, map[string]any{
				"configId":      m.configID,
				"modelId":       m.modelID,
				"modelName":     m.modelName,
				"contextWindow": m.contextWindow,
				"isDefault":     m.configID == fallback.configID,
			})
		}
		return map[string]any{
			"configId":        fallback.configID,
			"modelId":         fallback.modelID,
			"modelName":       fallback.modelName,
			"contextWindow":   fallback.contextWindow,
			"availableModels": list,
		}, nil
	})
}

func isNoRows(err error) bool { return err == pgx.ErrNoRows }
