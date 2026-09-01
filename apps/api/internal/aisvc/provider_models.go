package aisvc

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// ===== draft 上下文（统一「已保存的供应商」与「新建表单草稿」两种入参）=====

type draftContext struct {
	providerID  *int64
	def         *ProviderDef
	baseURL     *string
	apiKey      string
	extra       map[string]string
	headers     map[string]string
	apiProtocol string
}

func (d *draftContext) runtime() aicore.RuntimeConfig {
	rt := aicore.BuildRuntimeConfig(d.def.Key, derefStr(d.baseURL), d.apiKey, d.extra, d.headers, aicore.Quirks{})
	// BaseURL 为空时回落目录默认值（aicore.Chat 内部也会兜底，这里显式化）
	if rt.BaseURL == "" && d.def.DefaultBaseURL != nil {
		rt.BaseURL = strings.TrimRight(*d.def.DefaultBaseURL, "/")
	}
	return rt
}

// resolveDraftContext 复刻 resolveDraftContext。
func resolveDraftContext(ctx context.Context, userID int64, raw map[string]any) (*draftContext, error) {
	if raw["id"] != nil {
		providerID, err := requireID(raw["id"], "供应商 ID")
		if err != nil {
			return nil, err
		}
		rec, err := findOwnedProvider(ctx, userID, providerID)
		if err != nil {
			return nil, err
		}
		credential, err := loadCredential(ctx, userID, rec.CredentialID)
		if err != nil {
			return nil, err
		}
		def := FindProvider(rec.ProviderKey)
		if def == nil {
			return nil, badRequestMsg("请选择供应商")
		}

		// 允许前端在测试时临时覆盖 BaseUrl / 协议 / 自定义头，方便调试代理地址
		baseURL := rec.BaseURL
		if v, ok := raw["baseUrl"]; ok {
			baseURL = normalizeBaseURLInput(v)
		}
		headers := parseStringMapPtr(rec.HeadersJSON)
		if v, ok := raw["headers"]; ok {
			headers = parseStringMap(v)
		}
		apiProtocol := ProviderAPIProtocol(rec.ProviderKey, rec.OptionsJSON)
		if v, ok := raw["apiProtocol"]; ok {
			apiProtocol = ResolveAPIProtocol(def, flexToString(v))
		}
		return &draftContext{
			providerID:  &providerID,
			def:         def,
			baseURL:     baseURL,
			apiKey:      aicore.DecodeApiKey(credential.APIKeyEnc),
			extra:       aicore.DecodeExtra(derefStr(credential.ExtraEnc)),
			headers:     headers,
			apiProtocol: apiProtocol,
		}, nil
	}

	providerKey := strings.TrimSpace(flexToString(raw["providerKey"]))
	def := FindProvider(providerKey)
	if def == nil {
		return nil, badRequestMsg("请选择供应商")
	}
	credentialID, err := requireID(raw["credentialId"], "凭证 ID")
	if err != nil {
		return nil, err
	}
	credential, err := loadCredential(ctx, userID, credentialID)
	if err != nil {
		return nil, err
	}
	return &draftContext{
		def:         def,
		baseURL:     normalizeBaseURLInput(raw["baseUrl"]),
		apiKey:      aicore.DecodeApiKey(credential.APIKeyEnc),
		extra:       aicore.DecodeExtra(derefStr(credential.ExtraEnc)),
		headers:     parseStringMap(raw["headers"]),
		apiProtocol: ResolveAPIProtocol(def, raw["apiProtocol"]),
	}, nil
}

type savedModelInfo struct {
	modelID    string
	enabled    bool
	dimensions *int32
}

// FetchProviderModels POST /api/ai/provider/fetch-models。
// 支持两种入参：已保存的供应商 id，或者还没保存的草稿（providerKey + credentialId + baseUrl/headers）。
func FetchProviderModels(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	dc, err := resolveDraftContext(ctx, user.ID, body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	// 与 TS 一致：拉列表前把 BaseUrl 解析到最终生效值（用户没填时回落目录默认值）
	resolvedBaseURL := ResolveBaseURL(dc.def, strVal(dc.baseURL))
	models, fetched, warning := discoverProviderModels(ctx, dc.def, resolvedBaseURL, dc.apiKey, dc.headers)

	// 已经保存过的模型标记出来，前端直接反映勾选态
	saved := map[string]savedModelInfo{}
	if dc.providerID != nil {
		rows, qerr := db.Pool().Query(ctx,
			`SELECT model_id, enabled, dimensions FROM petrichor_ai_model WHERE provider_id = $1`, *dc.providerID)
		if qerr != nil {
			httpx.HandleError(c, qerr)
			return
		}
		for rows.Next() {
			var info savedModelInfo
			if err := rows.Scan(&info.modelID, &info.enabled, &info.dimensions); err != nil {
				rows.Close()
				httpx.HandleError(c, err)
				return
			}
			saved[info.modelID] = info
		}
		rows.Close()
		if rows.Err() != nil {
			httpx.HandleError(c, rows.Err())
			return
		}
	}

	items := make([]gin.H, 0, len(models))
	for _, m := range models {
		item := gin.H{
			"modelId":       m.ID,
			"kind":          m.Kind,
			"label":         m.Label,
			"contextWindow": m.ContextWindow,
			"preset":        m.Preset,
			"saved":         false,
			"enabled":       false,
			"dimensions":    nil,
		}
		if info, wasSaved := saved[m.ID]; wasSaved {
			item["saved"] = true
			item["enabled"] = info.enabled
			item["dimensions"] = nullableI64(info.dimensions)
		}
		items = append(items, item)
	}

	var warningOut any
	if warning != nil {
		warningOut = *warning
	}
	httpx.OK(c, gin.H{"fetched": fetched, "warning": warningOut, "items": items})
}

// ===== 模型输入校验与响应构造 =====

var validCapabilities = []string{"tools", "vision", "reasoning", "json"}

type modelInput struct {
	ModelID       string
	DisplayName   *string
	Kind          string
	ContextWindow *int64
	Capabilities  []string
	Enabled       bool
}

// validateModelInput 复刻 validateModelInput。
func validateModelInput(raw any) (modelInput, error) {
	value, _ := isRecord(raw)

	modelID := strings.TrimSpace(flexToString(value["modelId"]))
	if modelID == "" {
		return modelInput{}, badRequestMsg("模型 ID 不能为空")
	}
	kind := strings.TrimSpace(flexToString(value["kind"]))
	if kind != "LANGUAGE" && kind != "EMBEDDING" {
		return modelInput{}, badRequestMsg("模型类型应为 LANGUAGE 或 EMBEDDING")
	}
	return modelInput{
		ModelID:       modelID,
		DisplayName:   optionalString(value["displayName"]),
		Kind:          kind,
		ContextWindow: positiveIntegerOrNil(value["contextWindow"]),
		Capabilities:  parseCapabilities(value["capabilities"]),
		Enabled:       value["enabled"] == nil || truthy(value["enabled"]),
	}, nil
}

// parseCapabilities 复刻 parseCapabilities：只保留已知能力，顺序固定。
func parseCapabilities(raw any) []string {
	var source []any
	switch t := raw.(type) {
	case string:
		var parsed []any
		if json.Unmarshal([]byte(t), &parsed) == nil {
			source = parsed
		}
	case []any:
		source = t
	}
	present := map[string]bool{}
	for _, item := range source {
		if s, ok := item.(string); ok {
			present[s] = true
		}
	}
	out := []string{}
	for _, capability := range validCapabilities {
		if present[capability] {
			out = append(out, capability)
		}
	}
	return out
}

type modelRowFull struct {
	ID               int64
	UserID           int64
	ProviderID       int64
	ModelID          string
	DisplayName      *string
	Kind             string
	ContextWindow    *int32
	Dimensions       *int32
	CapabilitiesJSON *string
	Enabled          bool
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

const modelCols = `id, user_id, provider_id, model_id, display_name, kind, context_window, dimensions,
	capabilities_json, enabled, created_at, updated_at`

const modelColsP = `m.id, m.user_id, m.provider_id, m.model_id, m.display_name, m.kind, m.context_window, m.dimensions,
	m.capabilities_json, m.enabled, m.created_at, m.updated_at`

func (r *modelRowFull) scanInto() []any {
	return []any{&r.ID, &r.UserID, &r.ProviderID, &r.ModelID, &r.DisplayName, &r.Kind,
		&r.ContextWindow, &r.Dimensions, &r.CapabilitiesJSON, &r.Enabled, &r.CreatedAt, &r.UpdatedAt}
}

// buildModelResponse 复刻 buildModelResponse。
func buildModelResponse(rec modelRowFull, providerName, providerKey *string) gin.H {
	return gin.H{
		"id":            idStr(rec.ID),
		"providerId":    idStr(rec.ProviderID),
		"providerName":  nullableStr(providerName),
		"providerKey":   nullableStr(providerKey),
		"modelId":       rec.ModelID,
		"displayName":   rec.DisplayName,
		"kind":          rec.Kind,
		"contextWindow": nullableI64(rec.ContextWindow),
		"dimensions":    nullableI64(rec.Dimensions),
		"capabilities":  parseCapabilities(rec.CapabilitiesJSON),
		"enabled":       rec.Enabled,
		"createdAt":     httpx.FormatISO(rec.CreatedAt),
		"updatedAt":     httpx.FormatISO(rec.UpdatedAt),
	}
}

// SyncProviderModels POST /api/ai/provider/sync-models：整体覆盖语义，
// 传入列表之外的旧模型会被删除（被用途绑定引用的除外，避免绑定断链）。
func SyncProviderModels(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	providerID, err := requireID(body["providerId"], "供应商 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if _, err := findOwnedProvider(ctx, user.ID, providerID); err != nil {
		httpx.HandleError(c, err)
		return
	}

	rawItems, _ := body["models"].([]any)
	inputs := make([]modelInput, 0, len(rawItems))
	for _, item := range rawItems {
		input, verr := validateModelInput(item)
		if verr != nil {
			httpx.HandleError(c, verr)
			return
		}
		inputs = append(inputs, input)
	}
	if len(inputs) == 0 {
		httpx.HandleError(c, badRequestMsg("请至少勾选一个模型"))
		return
	}
	pool := db.Pool()

	type existingModel struct {
		id      int64
		modelID string
	}
	existing := map[string]existingModel{}
	var existingOrder []existingModel
	rows, err := pool.Query(ctx,
		`SELECT id, model_id FROM petrichor_ai_model WHERE provider_id = $1`, providerID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	for rows.Next() {
		var e existingModel
		if err := rows.Scan(&e.id, &e.modelID); err != nil {
			rows.Close()
			httpx.HandleError(c, err)
			return
		}
		existing[e.modelID] = e
		existingOrder = append(existingOrder, e)
	}
	rows.Close()
	if rows.Err() != nil {
		httpx.HandleError(c, rows.Err())
		return
	}

	keep := map[string]bool{}
	for _, input := range inputs {
		keep[input.ModelID] = true
	}

	// 被绑定引用的模型即使没勾选也保留，否则绑定会级联删除
	boundSet := map[int64]bool{}
	boundRows, err := pool.Query(ctx,
		`SELECT model_ref_id FROM petrichor_ai_binding WHERE user_id = $1`, user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	for boundRows.Next() {
		var ref int64
		if err := boundRows.Scan(&ref); err != nil {
			boundRows.Close()
			httpx.HandleError(c, err)
			return
		}
		boundSet[ref] = true
	}
	boundRows.Close()
	if boundRows.Err() != nil {
		httpx.HandleError(c, boundRows.Err())
		return
	}

	var removable []int64
	for _, e := range existingOrder {
		if !keep[e.modelID] && !boundSet[e.id] {
			removable = append(removable, e.id)
		}
	}
	if len(removable) > 0 {
		if _, err := pool.Exec(ctx,
			`DELETE FROM petrichor_ai_model WHERE id = ANY($1)`, removable); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}

	now := time.Now()
	for _, input := range inputs {
		current, exists := existing[input.ModelID]
		if exists {
			if _, err := pool.Exec(ctx, `
				UPDATE petrichor_ai_model SET display_name = $1, kind = $2, context_window = $3,
				       capabilities_json = $4, enabled = $5, updated_at = $6
				WHERE id = $7`,
				input.DisplayName, input.Kind, input.ContextWindow,
				jsonStringifyStrict(input.Capabilities), input.Enabled, now, current.id); err != nil {
				httpx.HandleError(c, err)
				return
			}
			continue
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO petrichor_ai_model (user_id, provider_id, model_id, display_name, kind, context_window, capabilities_json, enabled, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			user.ID, providerID, input.ModelID, input.DisplayName, input.Kind,
			input.ContextWindow, jsonStringifyStrict(input.Capabilities), input.Enabled, now); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}

	finalRows, err := pool.Query(ctx,
		`SELECT `+modelCols+` FROM petrichor_ai_model WHERE provider_id = $1 ORDER BY kind, model_id`, providerID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer finalRows.Close()
	items := []gin.H{}
	for finalRows.Next() {
		var rec modelRowFull
		if err := finalRows.Scan(rec.scanInto()...); err != nil {
			httpx.HandleError(c, err)
			return
		}
		items = append(items, buildModelResponse(rec, nil, nil))
	}
	httpx.OK(c, gin.H{"items": items})
}

// ===== 连通性测试 =====

// recordCheck 把连通性测试结果写回供应商记录；草稿（providerID 为 nil）跳过。
func recordCheck(ctx context.Context, providerID *int64, status, message string) {
	if providerID == nil {
		return
	}
	now := time.Now()
	_, _ = db.Pool().Exec(ctx,
		`UPDATE petrichor_ai_provider SET last_checked_at = $1, last_check_status = $2,
		        last_check_message = $3, updated_at = $4 WHERE id = $5`,
		now, status, message, now, *providerID)
}

// TestProvider POST /api/ai/provider/test：
// 用最小的一次真实调用验证配置是否可用，结果写回供应商记录。
// 不消耗多少 token，但能一次性验出 Key、BaseUrl、模型名、鉴权方式是否都对。
func TestProvider(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	dc, err := resolveDraftContext(ctx, user.ID, body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	// 优先用调用方指定的模型；没指定时才回落到目录预置清单。
	// 多数聚合平台的预置清单是空的，这时必须让用户先拉列表再选，不能瞎猜一个模型名。
	modelID := strings.TrimSpace(flexToString(body["modelId"]))
	if modelID == "" {
		for _, preset := range dc.def.Models {
			if preset.Kind == "LANGUAGE" {
				modelID = preset.ID
				break
			}
		}
	}
	if modelID == "" {
		httpx.HandleError(c, badRequestMsg("%s 没有内置可用于测试的模型，请先点「获取模型列表」并选择一个测试用模型", dc.def.Name))
		return
	}

	started := time.Now()
	maxTokens := int64(16)
	opts := aicore.GenerationOptions{MaxTokens: &maxTokens}
	result, chatErr := aicore.Chat(ctx, dc.runtime(), modelID,
		[]aicore.ChatMessage{{Role: "user", Content: "ping"}}, opts)

	if chatErr == nil {
		latency := time.Since(started).Milliseconds()
		message := fmt.Sprintf("连通正常，耗时 %dms", latency)
		recordCheck(ctx, dc.providerID, "OK", message)
		sample := truncateRunes(strings.TrimSpace(result.Answer), 200)
		httpx.OK(c, gin.H{"status": "OK", "latencyMs": latency, "message": message, "sample": sample})
		return
	}

	message := chatErr.Error()
	failureMessage := truncateRunes(message, 500)
	recordCheck(ctx, dc.providerID, "FAILED", failureMessage)
	httpx.OK(c, gin.H{
		"status":    "FAILED",
		"latencyMs": time.Since(started).Milliseconds(),
		"message":   message,
		"sample":    nil,
	})
}

// truncateRunes 按 rune 截断（对应 JS String.slice 的 UTF-16 近似）。
func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
