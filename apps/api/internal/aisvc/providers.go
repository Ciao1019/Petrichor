// providers.go 对照 provider-handlers.ts + provider-models.ts：
// 供应商实例 CRUD、静态目录、在线模型发现（fetch-models）、勾选同步（sync-models）与连通性测试。
package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

type providerRow struct {
	ID               int64
	UserID           int64
	ProviderKey      string
	Name             string
	BaseURL          *string
	CredentialID     int64
	Enabled          bool
	HeadersJSON      *string
	OptionsJSON      *string
	LastCheckedAt    *time.Time
	LastCheckStatus  *string
	LastCheckMessage *string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

const providerCols = `id, user_id, provider_key, name, base_url, credential_id, enabled, headers_json, options_json,
	last_checked_at, last_check_status, last_check_message, created_at, updated_at`

const providerColsP = `p.id, p.user_id, p.provider_key, p.name, p.base_url, p.credential_id, p.enabled, p.headers_json, p.options_json,
	p.last_checked_at, p.last_check_status, p.last_check_message, p.created_at, p.updated_at`

func (r *providerRow) scanInto() []any {
	return []any{&r.ID, &r.UserID, &r.ProviderKey, &r.Name, &r.BaseURL, &r.CredentialID, &r.Enabled,
		&r.HeadersJSON, &r.OptionsJSON, &r.LastCheckedAt, &r.LastCheckStatus, &r.LastCheckMessage,
		&r.CreatedAt, &r.UpdatedAt}
}

// ===== 供应商目录 =====

// ListProviderCatalog POST /api/ai/provider/catalog：静态目录，供前端渲染供应商选择器。
func ListProviderCatalog(c *gin.Context) {
	httpx.OK(c, gin.H{"items": listCatalogSummaries()})
}

// ===== 响应构造（config-logic.buildProviderResponse 移植）=====

func buildProviderResponse(rec providerRow, credentialName *string, modelCount, enabledModelCount int64) gin.H {
	def := FindProvider(rec.ProviderKey)

	var accent any = "slate"
	var kinds any = []any{}
	var apiProtocols = SupportedAPIProtocols(nil)
	var effectiveBaseURL any = rec.BaseURL
	supportsListing := false
	apiProtocol := "chat"
	if def != nil {
		accent = def.Accent
		kinds = def.Kinds
		apiProtocols = SupportedAPIProtocols(def)
		effectiveBaseURL = ResolveBaseURL(def, strVal(rec.BaseURL))
		supportsListing = def.Listing != "none"
		apiProtocol = ProviderAPIProtocol(rec.ProviderKey, rec.OptionsJSON)
	}

	return gin.H{
		"id":                   idStr(rec.ID),
		"providerKey":          rec.ProviderKey,
		"providerName":         providerDisplayName(def, rec),
		"accent":               accent,
		"name":                 rec.Name,
		"baseUrl":              rec.BaseURL,
		"effectiveBaseUrl":     effectiveBaseURL,
		"supportsModelListing": supportsListing,
		"kinds":                kinds,
		"apiProtocols":         apiProtocols,
		"apiProtocol":          apiProtocol,
		"credentialId":         idStr(rec.CredentialID),
		"credentialName":       nullableStr(credentialName),
		"enabled":              rec.Enabled,
		"headers":              parseStringMapPtr(rec.HeadersJSON),
		"options":              storedJSONObject(rec.OptionsJSON),
		"modelCount":           modelCount,
		"enabledModelCount":    enabledModelCount,
		"lastCheckedAt":        nullableTime(rec.LastCheckedAt),
		"lastCheckStatus":      rec.LastCheckStatus,
		"lastCheckMessage":     rec.LastCheckMessage,
		"createdAt":            httpx.FormatISO(rec.CreatedAt),
		"updatedAt":            httpx.FormatISO(rec.UpdatedAt),
	}
}

func providerDisplayName(def *ProviderDef, rec providerRow) string {
	if def != nil {
		return def.Name
	}
	return rec.ProviderKey
}

func nullableStr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func nullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.FormatISO(*t)
}

// ===== 校验与入库 =====

// normalizeBaseURLInput 复刻 normalizeBaseUrlInput：没填存 null，填了去掉尾部斜杠。
func normalizeBaseURLInput(raw any) *string {
	value := strings.TrimRight(strings.TrimSpace(flexToString(raw)), "/")
	if value == "" {
		return nil
	}
	return &value
}

// validateProviderForm 复刻 validateProviderInput 的核心校验，返回规范化后的表单。
func validateProviderForm(raw map[string]any) (providerKey, name string, baseURL *string,
	credentialID int64, enabled bool, headers map[string]string, options map[string]any, err error) {
	key := flexToString(raw["providerKey"])
	def := FindProvider(key)
	if def == nil {
		return "", "", nil, 0, false, nil, nil, badRequestMsg("请选择供应商")
	}

	name = strings.TrimSpace(flexToString(raw["name"]))
	if name == "" {
		name = def.Name
	}
	if runeLen(name) > 64 {
		return "", "", nil, 0, false, nil, nil, badRequestMsg("供应商名称不能超过 64 个字符")
	}

	baseURL = normalizeBaseURLInput(raw["baseUrl"])
	if err := AssertBaseURLSatisfied(def, baseURL); err != nil {
		return "", "", nil, 0, false, nil, nil, err
	}

	credentialID, err = requireID(raw["credentialId"], "凭证 ID")
	if err != nil {
		return "", "", nil, 0, false, nil, nil, err
	}

	opts, ok := isRecord(raw["options"])
	if !ok {
		opts = parseJSONObjectText(flexToString(optionalString(raw["options"])))
	}
	copied := map[string]any{}
	for k, v := range opts {
		copied[k] = v
	}
	// 协议存成规范值，避免前端传脏数据流进 optionsJson
	copied["apiProtocol"] = ResolveAPIProtocol(def, copied["apiProtocol"])

	enabled = true
	if raw["enabled"] != nil {
		enabled = truthy(raw["enabled"])
	}
	return key, name, baseURL, credentialID, enabled, parseStringMap(raw["headers"]), copied, nil
}

func findOwnedProvider(ctx context.Context, userID, id int64) (providerRow, error) {
	var rec providerRow
	err := db.Pool().QueryRow(ctx,
		`SELECT `+providerCols+` FROM petrichor_ai_provider WHERE id = $1 AND user_id = $2 LIMIT 1`,
		id, userID).Scan(rec.scanInto()...)
	if err == pgx.ErrNoRows {
		return rec, httpx.NotFound("供应商不存在")
	}
	return rec, err
}

func loadCredential(ctx context.Context, userID, credentialID int64) (credentialRow, error) {
	return findOwnedCredential(ctx, userID, credentialID)
}

// ensureUniqueProviderName 复刻 ensureUniqueName。
func ensureUniqueProviderName(ctx context.Context, userID int64, name string, excludeID int64) error {
	rows, err := db.Pool().Query(ctx,
		`SELECT id FROM petrichor_ai_provider WHERE user_id = $1 AND name = $2 LIMIT 2`,
		userID, name)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return err
		}
		if id != excludeID {
			return badRequestMsg("已存在同名供应商，请换一个名称")
		}
	}
	return rows.Err()
}

// ===== CRUD 接口 =====

// ListProviders POST /api/ai/provider/list。
func ListProviders(c *gin.Context) {
	user := auth.CurrentUser(c)
	ctx := c.Request.Context()
	pool := db.Pool()

	countBy := func(enabledOnly bool) map[int64]int64 {
		q := `SELECT provider_id, count(*) FROM petrichor_ai_model WHERE user_id = $1`
		if enabledOnly {
			q += ` AND enabled = true`
		}
		q += ` GROUP BY provider_id`
		m := map[int64]int64{}
		rows, err := pool.Query(ctx, q, user.ID)
		if err != nil {
			return m
		}
		defer rows.Close()
		for rows.Next() {
			var pid, total int64
			if rows.Scan(&pid, &total) == nil {
				m[pid] = total
			}
		}
		return m
	}
	totalMap := countBy(false)
	enabledMap := countBy(true)

	rows, err := pool.Query(ctx, `
		SELECT `+providerColsP+`, c.name
		FROM petrichor_ai_provider p
		JOIN petrichor_ai_credential c ON c.id = p.credential_id
		WHERE p.user_id = $1
		ORDER BY p.updated_at DESC, p.id DESC`, user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var rec providerRow
		var credentialName *string
		dest := rec.scanInto()
		dest = append(dest, &credentialName)
		if err := rows.Scan(dest...); err != nil {
			httpx.HandleError(c, err)
			return
		}
		items = append(items, buildProviderResponse(rec, credentialName, totalMap[rec.ID], enabledMap[rec.ID]))
	}
	httpx.OK(c, gin.H{"items": items})
}

// CreateProvider POST /api/ai/provider/create。
func CreateProvider(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	key, name, baseURL, credentialID, enabled, headers, options, err := validateProviderForm(body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if _, err := loadCredential(ctx, user.ID, credentialID); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if err := ensureUniqueProviderName(ctx, user.ID, name, 0); err != nil {
		httpx.HandleError(c, err)
		return
	}

	var rec providerRow
	err = db.Pool().QueryRow(ctx,
		`INSERT INTO petrichor_ai_provider (user_id, provider_key, name, base_url, credential_id, enabled, headers_json, options_json)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING `+providerCols,
		user.ID, key, name, baseURL, credentialID, enabled, jsonStringifyStrict(headers), jsonStringifyStrict(options)).
		Scan(rec.scanInto()...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, buildProviderResponse(rec, nil, 0, 0))
}

// UpdateProvider POST /api/ai/provider/update。
// 与 TS 一致：providerKey/name/credentialId/enabled 用 ?? 回落旧值；
// baseUrl/headers/options 区分「未传」（沿用）与「传 null/空」（清空/置空字典）。
func UpdateProvider(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	id, err := requireID(body["id"], "供应商 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	existing, err := findOwnedProvider(ctx, user.ID, id)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	merged := map[string]any{
		"providerKey":  orElse(body["providerKey"], existing.ProviderKey),
		"name":         orElse(body["name"], existing.Name),
		"credentialId": orElse(body["credentialId"], float64(existing.CredentialID)),
		"enabled":      orElse(body["enabled"], existing.Enabled),
	}
	if v, ok := body["baseUrl"]; ok {
		merged["baseUrl"] = v
	} else {
		merged["baseUrl"] = strVal(existing.BaseURL)
	}
	if v, ok := body["headers"]; ok {
		merged["headers"] = v
	} else {
		merged["headers"] = derefStr(existing.HeadersJSON)
	}
	if v, ok := body["options"]; ok {
		merged["options"] = v
	} else {
		merged["options"] = derefStr(existing.OptionsJSON)
	}

	key, name, baseURL, credentialID, enabled, headers, options, err := validateProviderForm(merged)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if _, err := loadCredential(ctx, user.ID, credentialID); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if name != existing.Name {
		if err := ensureUniqueProviderName(ctx, user.ID, name, id); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}

	var rec providerRow
	err = db.Pool().QueryRow(ctx,
		`UPDATE petrichor_ai_provider SET provider_key = $1, name = $2, base_url = $3, credential_id = $4,
		        enabled = $5, headers_json = $6, options_json = $7, updated_at = $8
		 WHERE id = $9 AND user_id = $10 RETURNING `+providerCols,
		key, name, baseURL, credentialID, enabled, jsonStringifyStrict(headers), jsonStringifyStrict(options),
		time.Now(), id, user.ID).Scan(rec.scanInto()...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, buildProviderResponse(rec, nil, 0, 0))
}

// DeleteProvider POST /api/ai/provider/delete：有绑定占用时先提示改绑。
func DeleteProvider(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	id, err := requireID(body["id"], "供应商 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if _, err := findOwnedProvider(ctx, user.ID, id); err != nil {
		httpx.HandleError(c, err)
		return
	}

	// 模型随供应商级联删除，绑定又级联到模型，因此先提示占用情况
	var bound int64
	if err := db.Pool().QueryRow(ctx, `
		SELECT count(*) FROM petrichor_ai_binding b
		JOIN petrichor_ai_model m ON m.id = b.model_ref_id
		WHERE b.user_id = $1 AND m.provider_id = $2`, user.ID, id).Scan(&bound); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if bound > 0 {
		httpx.HandleError(c, badRequestMsg("该供应商下有 %d 个模型正被用途绑定使用，请先改绑其它模型", bound))
		return
	}

	if _, err := db.Pool().Exec(ctx,
		`DELETE FROM petrichor_ai_provider WHERE id = $1 AND user_id = $2`, id, user.ID); err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Status(200)
}

// ===== 模型发现（provider-models.ts 移植）=====

type discoveredModel struct {
	ID            string
	Kind          string
	Label         *string
	ContextWindow int64
	Preset        bool
}

// discoverProviderModels 拉取模型列表。永远不抛异常：在线失败时退回内置清单并带上 warning。
func discoverProviderModels(ctx context.Context, def *ProviderDef,
	baseURL *string, apiKey string, headers map[string]string) ([]discoveredModel, bool, *string) {
	presets := toPresetModels(def)

	if def.Listing == "none" {
		warning := fmt.Sprintf("%s 没有公开的模型列表接口，已列出内置模型，可直接勾选或手动添加。", def.Name)
		return presets, false, &warning
	}

	ids, err := fetchModelIDs(ctx, def.Listing, baseURL, apiKey, headers)
	if err != nil {
		warning := describeDiscoveryError(err) + "，已回退到内置模型清单。"
		return presets, false, &warning
	}
	if len(ids) == 0 {
		warning := "接口返回的模型列表为空，已回退到内置模型清单。"
		return presets, false, &warning
	}
	return mergeWithPresets(def, ids, presets), true, nil
}

func toPresetModels(def *ProviderDef) []discoveredModel {
	out := make([]discoveredModel, 0, len(def.Models))
	for _, m := range def.Models {
		ctx := int64(0)
		if m.ContextWindow != nil {
			ctx = *m.ContextWindow
		} else {
			ctx = GuessContextWindow(m.ID)
		}
		out = append(out, discoveredModel{ID: m.ID, Kind: m.Kind, Label: m.Label, ContextWindow: ctx, Preset: true})
	}
	return out
}

// buildListingRequest 各 listing 模式的请求形状（复刻 buildListingRequest）。
func buildListingRequest(mode, baseURL, apiKey string) (string, map[string]string) {
	switch mode {
	case "anthropic":
		return baseURL + "/models?limit=1000", map[string]string{
			"x-api-key":         apiKey,
			"anthropic-version": "2023-06-01",
		}
	case "google":
		// Gemini 用 query 参数带 key，且分页 pageSize 上限 1000
		return baseURL + "/models?pageSize=1000&key=" + url.QueryEscape(apiKey), map[string]string{}
	case "cohere":
		base := regexp.MustCompile(`/v2$`).ReplaceAllString(baseURL, "/v1")
		return base + "/models?page_size=1000", map[string]string{"Authorization": "Bearer " + apiKey}
	default:
		return baseURL + "/models", map[string]string{"Authorization": "Bearer " + apiKey}
	}
}

const discoveryTimeout = 15 * time.Second

var discoveryClient = &http.Client{Timeout: discoveryTimeout}

func fetchModelIDs(ctx context.Context, mode string, baseURL *string, apiKey string, headers map[string]string) ([]string, error) {
	base := strings.TrimRight(derefStr(baseURL), "/")
	if base == "" {
		return nil, fmt.Errorf("缺少 BaseUrl，无法拉取模型列表")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("缺少 API Key，无法拉取模型列表")
	}

	reqURL, reqHeaders := buildListingRequest(mode, base, strings.TrimSpace(apiKey))
	fetchCtx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range reqHeaders {
		req.Header.Set(k, v)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := discoveryClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		hint := strings.TrimSpace(string(data))
		if hint != "" {
			runes := []rune(hint)
			if len(runes) > 160 {
				hint = string(runes[:160])
			}
			hint = "（" + hint + "）"
		}
		return nil, fmt.Errorf("模型列表接口返回 HTTP %d%s", resp.StatusCode, hint)
	}

	var payload any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return parseModelIDs(mode, payload), nil
}

// parseModelIDs 各 listing 模式的响应解析（导出形状与 TS 一致）。
func parseModelIDs(mode string, payload any) []string {
	root, ok := isRecord(payload)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	appendID := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}

	if mode == "google" || mode == "cohere" {
		models, _ := root["models"].([]any)
		for _, entry := range models {
			m, ok := isRecord(entry)
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			if mode == "google" {
				name = regexp.MustCompile(`^models/`).ReplaceAllString(name, "")
			}
			appendID(name)
		}
		return out
	}

	// anthropic 与 openai 兼容端点都是 { data: [{ id }] }
	data, _ := root["data"].([]any)
	for _, entry := range data {
		if s, ok := entry.(string); ok {
			appendID(s)
			continue
		}
		if m, ok := isRecord(entry); ok {
			id, _ := m["id"].(string)
			appendID(id)
		}
	}
	return out
}

// mergeWithPresets 在线结果与内置清单合并：在线拿到的 id 为准，内置清单里在线没返回的追加在后面。
func mergeWithPresets(def *ProviderDef, ids []string, presets []discoveredModel) []discoveredModel {
	seen := map[string]bool{}
	merged := make([]discoveredModel, 0, len(ids)+len(presets))

	for _, rawID := range ids {
		value := strings.TrimSpace(rawID)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		catalog := FindCatalogModel(def, value)
		contextWindow := GuessContextWindow(value)
		kind := GuessModelKind(value)
		var label *string
		if catalog != nil {
			kind = catalog.Kind
			label = catalog.Label
			if catalog.ContextWindow != nil {
				contextWindow = *catalog.ContextWindow
			}
		}
		merged = append(merged, discoveredModel{ID: value, Kind: kind, Label: label, ContextWindow: contextWindow})
	}
	for _, preset := range presets {
		if seen[preset.ID] {
			continue
		}
		seen[preset.ID] = true
		merged = append(merged, preset)
	}
	return merged
}

func describeDiscoveryError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "拉取模型列表超时"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "拉取模型列表超时"
	}
	if err.Error() != "" {
		return err.Error()
	}
	return "拉取模型列表失败"
}
