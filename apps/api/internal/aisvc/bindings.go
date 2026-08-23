// bindings.go 对照 binding-handlers.ts + config-logic.ts 的公共解析层：
// 用途绑定 set/clear/list，以及全包共用的入参校验、生成参数解析、响应构造工具。
package aisvc

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// ===== 共享小工具（config-logic.ts 移植）=====

func badRequestMsg(format string, args ...any) error {
	return httpx.BadRequest(fmt.Sprintf(format, args...))
}

func idStr(id int64) string { return strconv.FormatInt(id, 10) }

// requireID 复刻 requireId：字符串或数字形式的非负整数，非法报「{label}非法」。
func requireID(raw any, label string) (int64, error) {
	value := strings.TrimSpace(flexToString(raw))
	if !regexp.MustCompile(`^\d+$`).MatchString(value) {
		return 0, badRequestMsg("%s非法", label)
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, badRequestMsg("%s非法", label)
	}
	return n, nil
}

// optionalString 复刻 optionalString：trim 后空串返回 nil。
func optionalString(raw any) *string {
	value := strings.TrimSpace(flexToString(raw))
	if value == "" {
		return nil
	}
	return &value
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func isRecord(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok && m != nil
}

// parseJSONObjectText 解析 JSON 对象字符串，失败返回空对象。
func parseJSONObjectText(raw string) map[string]any {
	text := strings.TrimSpace(raw)
	if text == "" {
		return map[string]any{}
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil || parsed == nil {
		return map[string]any{}
	}
	return parsed
}

// storedJSONObject 把库里的 JSON 文本列安全转成对象（nil → {}）。
func storedJSONObject(raw *string) map[string]any {
	if raw == nil {
		return map[string]any{}
	}
	return parseJSONObjectText(*raw)
}

// jsonStringifyStrict 序列化为 JSON 字符串；失败返回空串（对应 TS JSON.stringify）。
func jsonStringifyStrict(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// parseStringMap 复刻 parseStringMap：任意入参规整成 string->string 字典。
func parseStringMap(raw any) map[string]string {
	var source map[string]any
	if s, ok := raw.(string); ok {
		source = parseJSONObjectText(s)
	} else if m, ok := isRecord(raw); ok {
		source = m
	}
	result := map[string]string{}
	for key, value := range source {
		name := strings.TrimSpace(key)
		if name == "" {
			continue
		}
		if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
			result[name] = strings.TrimSpace(s)
		}
	}
	return result
}

func parseStringMapPtr(raw *string) map[string]string {
	if raw == nil {
		return map[string]string{}
	}
	return parseStringMap(*raw)
}

// jsNumber 复刻 Number() 的宽松转换；ok=false 表示 NaN。
func jsNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case nil:
		return 0, true // Number(null) === 0
	case float64:
		return t, true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case string:
		trimmed := strings.TrimSpace(t)
		if trimmed == "" {
			return 0, true // Number("") === 0
		}
		f, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

// positiveIntegerOrNil 复刻 positiveIntegerOrNull。
func positiveIntegerOrNil(v any) *int64 {
	n, ok := jsNumber(v)
	if !ok || n != float64(int64(n)) || n <= 0 {
		return nil
	}
	parsed := int64(n)
	return &parsed
}

// numberOrNil 复刻 numberOrNull：有限数才收。
func numberOrNil(v any) *float64 {
	n, ok := jsNumber(v)
	if !ok {
		return nil
	}
	return &n
}

// normalizeThinking 复刻 normalizeThinking："enabled"/"disabled"，其余为 nil。
func normalizeThinking(v any) *string {
	if m, ok := isRecord(v); ok {
		return normalizeThinking(m["type"])
	}
	if b, ok := v.(bool); ok {
		if b {
			return strPtr("enabled")
		}
		return strPtr("disabled")
	}
	text := strings.ToLower(strings.TrimSpace(flexToString(v)))
	if text == "enabled" || text == "disabled" {
		return &text
	}
	return nil
}

// booleanOrDefault 复刻 booleanOrDefault：支持 "true"/"1"/"yes"/"on" 等字符串。
func booleanOrDefault(v any, defaultValue bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	if s, ok := v.(string); ok {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
	}
	return defaultValue
}

// truthy 复刻 Boolean()：注意非空字符串一律为真。
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	default:
		return true
	}
}

// parseGenerationOptionsRaw 复刻 parseGenerationOptions(Record)：含 max_tokens / deepSeekThinking 别名。
func parseGenerationOptionsRaw(raw any) aicore.GenerationOptions {
	opts := aicore.GenerationOptions{}
	m, _ := isRecord(raw)

	maxV, hasMax := m["maxTokens"]
	if !hasMax || maxV == nil {
		maxV = m["max_tokens"]
	}
	opts.MaxTokens = positiveIntegerOrNil(maxV)

	if temp, hasTemp := m["temperature"]; hasTemp {
		opts.Temperature = numberOrNil(temp)
	} else {
		opts.Temperature = nil
	}

	thinkV, hasThink := m["thinking"]
	if !hasThink || thinkV == nil {
		thinkV = m["deepSeekThinking"]
	}
	opts.Thinking = normalizeThinking(thinkV)

	dt := booleanOrDefault(m["disableThinkingForTools"], true)
	opts.DisableThinkingForTools = &dt
	return opts
}

// parseStoredGenerationOptions 从库里存的 optionsJson 还原生成参数。
func parseStoredGenerationOptions(raw *string) aicore.GenerationOptions {
	opts := aicore.GenerationOptions{DisableThinkingForTools: boolPtr(true)}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return opts
	}
	_ = json.Unmarshal([]byte(*raw), &opts)
	if opts.DisableThinkingForTools == nil {
		opts.DisableThinkingForTools = boolPtr(true)
	}
	return opts
}

func boolPtr(v bool) *bool { return &v }

// ===== 用途与模型类型 =====

var aiPurposes = []string{"CHAT", "VISION", "DOC_QA", "EMBEDDING"}

var purposeModelKind = map[string]string{
	"CHAT":      "LANGUAGE",
	"VISION":    "LANGUAGE",
	"DOC_QA":    "LANGUAGE",
	"EMBEDDING": "EMBEDDING",
}

// parsePurpose 复刻 parsePurpose。
func parsePurpose(raw any) (string, bool) {
	value := strings.TrimSpace(flexToString(raw))
	for _, p := range aiPurposes {
		if p == value {
			return value, true
		}
	}
	return "", false
}

// requirePurpose 复刻 requirePurpose。
func requirePurpose(raw any) (string, error) {
	purpose, ok := parsePurpose(raw)
	if !ok {
		return "", badRequestMsg("用途不能为空，应为 CHAT / VISION / DOC_QA / EMBEDDING 之一")
	}
	return purpose, nil
}

func nullableIDStr(id *int64) any {
	if id == nil {
		return nil
	}
	return idStr(*id)
}

func nullableI64(v *int32) any {
	if v == nil {
		return nil
	}
	return int64(*v)
}

// ===== 用途绑定接口 =====

type bindingRow struct {
	ID          int64
	Purpose     string
	ModelRefID  int64
	OptionsJSON *string
	UpdatedAt   time.Time
}

// buildBindingResponse 复刻 buildBindingResponse。
func buildBindingResponse(rec bindingRow, modelID, displayName *string,
	contextWindow, dimensions *int32, providerID *int64, providerName, providerKey *string) gin.H {
	return gin.H{
		"id":               idStr(rec.ID),
		"purpose":          rec.Purpose,
		"modelRefId":       idStr(rec.ModelRefID),
		"modelId":          modelID,
		"modelDisplayName": displayName,
		"providerId":       nullableIDStr(providerID),
		"providerName":     providerName,
		"providerKey":      providerKey,
		"contextWindow":    nullableI64(contextWindow),
		"dimensions":       nullableI64(dimensions),
		"options":          parseStoredGenerationOptions(rec.OptionsJSON),
		"updatedAt":        httpx.FormatISO(rec.UpdatedAt),
	}
}

// ListBindings POST /api/ai/binding/list：四个用途的当前绑定，未绑定的返回 null 占位。
func ListBindings(c *gin.Context) {
	user := auth.CurrentUser(c)
	rows, err := db.Pool().Query(c.Request.Context(), `
		SELECT b.id, b.purpose, b.model_ref_id, b.options_json, b.updated_at,
		       m.model_id, m.display_name, m.context_window, m.dimensions,
		       p.id, p.name, p.provider_key
		FROM petrichor_ai_binding b
		LEFT JOIN petrichor_ai_model m ON m.id = b.model_ref_id
		LEFT JOIN petrichor_ai_provider p ON p.id = m.provider_id
		WHERE b.user_id = $1`, user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	byPurpose := map[string]gin.H{}
	for rows.Next() {
		var rec bindingRow
		var modelID, displayName, providerName, providerKey *string
		var contextWindow, dimensions *int32
		var providerID *int64
		if err := rows.Scan(&rec.ID, &rec.Purpose, &rec.ModelRefID, &rec.OptionsJSON, &rec.UpdatedAt,
			&modelID, &displayName, &contextWindow, &dimensions,
			&providerID, &providerName, &providerKey); err != nil {
			httpx.HandleError(c, err)
			return
		}
		byPurpose[rec.Purpose] = buildBindingResponse(rec, modelID, displayName,
			contextWindow, dimensions, providerID, providerName, providerKey)
	}

	items := make([]gin.H, 0, len(aiPurposes))
	for _, purpose := range aiPurposes {
		var binding gin.H
		if b, ok := byPurpose[purpose]; ok {
			binding = b
		}
		items = append(items, gin.H{
			"purpose":      purpose,
			"requiredKind": purposeModelKind[purpose],
			"binding":      binding,
		})
	}
	httpx.OK(c, gin.H{"items": items})
}

// SetBinding POST /api/ai/binding/set：绑定或改绑某个用途（upsert）。
func SetBinding(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	purpose, err := requirePurpose(body["purpose"])
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	modelRefID, err := requireID(body["modelRefId"], "模型 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	// 模型必须存在且属于当前用户，供应商与凭证链路完整（inner join 同 TS）
	var (
		modelID         string
		displayName     *string
		modelKind       string
		modelEnabled    bool
		contextWindow   *int32
		dimensions      *int32
		providerID      int64
		providerName    string
		providerKey     string
		baseURL         *string
		providerEnabled bool
		headersJSON     *string
		apiKeyEnc       string
		extraEnc        *string
	)
	err = db.Pool().QueryRow(ctx, `
		SELECT m.model_id, m.display_name, m.kind, m.enabled, m.context_window, m.dimensions,
		       p.id, p.name, p.provider_key, p.base_url, p.enabled, p.headers_json,
		       c.api_key_enc, c.extra_enc
		FROM petrichor_ai_model m
		JOIN petrichor_ai_provider p ON p.id = m.provider_id
		JOIN petrichor_ai_credential c ON c.id = p.credential_id
		WHERE m.id = $1 AND m.user_id = $2
		LIMIT 1`, modelRefID, user.ID).
		Scan(&modelID, &displayName, &modelKind, &modelEnabled, &contextWindow, &dimensions,
			&providerID, &providerName, &providerKey, &baseURL, &providerEnabled, &headersJSON,
			&apiKeyEnc, &extraEnc)
	if err != nil {
		httpx.HandleError(c, httpx.NotFound("模型不存在"))
		return
	}
	if !modelEnabled {
		httpx.HandleError(c, badRequestMsg("该模型已停用，请先在供应商下启用它"))
		return
	}
	if !providerEnabled {
		httpx.HandleError(c, badRequestMsg("该模型所属的供应商已停用"))
		return
	}
	requiredKind := purposeModelKind[purpose]
	if modelKind != requiredKind {
		if requiredKind == "EMBEDDING" {
			httpx.HandleError(c, badRequestMsg("向量嵌入用途只能绑定向量模型"))
		} else {
			httpx.HandleError(c, badRequestMsg("该用途只能绑定语言模型"))
		}
		return
	}

	optionsBody, _ := isRecord(body["options"])
	options := parseGenerationOptionsRaw(optionsBody)

	now := time.Now()
	var existingID int64
	existingErr := db.Pool().QueryRow(ctx,
		`SELECT id FROM petrichor_ai_binding WHERE user_id = $1 AND purpose = $2 LIMIT 1`,
		user.ID, purpose).Scan(&existingID)

	var saved bindingRow
	if existingErr == nil {
		err = db.Pool().QueryRow(ctx,
			`UPDATE petrichor_ai_binding SET model_ref_id = $1, options_json = $2, updated_at = $3
			 WHERE id = $4 RETURNING id, purpose, model_ref_id, options_json, updated_at`,
			modelRefID, jsonStringifyStrict(options), now, existingID).
			Scan(&saved.ID, &saved.Purpose, &saved.ModelRefID, &saved.OptionsJSON, &saved.UpdatedAt)
	} else {
		err = db.Pool().QueryRow(ctx,
			`INSERT INTO petrichor_ai_binding (user_id, purpose, model_ref_id, options_json, updated_at)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, purpose, model_ref_id, options_json, updated_at`,
			user.ID, purpose, modelRefID, jsonStringifyStrict(options), now).
			Scan(&saved.ID, &saved.Purpose, &saved.ModelRefID, &saved.OptionsJSON, &saved.UpdatedAt)
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	// 绑定向量模型时顺手探测维度：让用户立刻看到维度并提前建好向量索引。
	// 探测失败不影响绑定本身——真正 embed 时还会自愈一次。
	outDimensions := dimensions
	if purpose == "EMBEDDING" && dimensions == nil {
		rt := aicore.BuildRuntimeConfig(providerKey, derefStr(baseURL),
			aicore.DecodeApiKey(apiKeyEnc), aicore.DecodeExtra(derefStr(extraEnc)),
			parseStringMapPtr(headersJSON), aicore.Quirks{})
		dims, probeErr := probeEmbeddingDimensions(ctx, rt, modelID)
		if probeErr != nil {
			slog.Warn("[ai] 绑定向量模型时探测维度失败，将在首次调用时重试", "error", probeErr)
		} else if persistErr := persistDimensions(ctx, modelRefID, dims); persistErr != nil {
			slog.Warn("[ai] 绑定向量模型时探测维度失败，将在首次调用时重试", "error", persistErr)
		} else {
			v := int32(dims)
			outDimensions = &v
		}
	}

	httpx.OK(c, buildBindingResponse(saved, &modelID, displayName,
		contextWindow, outDimensions, &providerID, &providerName, &providerKey))
}

// ClearBinding POST /api/ai/binding/clear：解绑某个用途。
func ClearBinding(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	purpose, err := requirePurpose(body["purpose"])
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if _, err := db.Pool().Exec(c.Request.Context(),
		`DELETE FROM petrichor_ai_binding WHERE user_id = $1 AND purpose = $2`,
		user.ID, purpose); err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Status(200)
}
