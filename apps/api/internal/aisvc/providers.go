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

	"petrichor/api/internal/aicore"
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
