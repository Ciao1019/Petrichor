// credentials.go 对照 credential-handlers.ts：凭证库 CRUD。
// API Key 用 spring AES 加密存储（aicore.EncodeApiKey），列表只回掩码。
package aisvc

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

type credentialRow struct {
	ID          int64
	Name        string
	ProviderKey *string
	APIKeyEnc   string
	ExtraEnc    *string
	LastUsedAt  *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const credentialCols = `id, name, provider_key, api_key_enc, extra_enc, last_used_at, created_at, updated_at`

func (r *credentialRow) scanInto() []any {
	return []any{&r.ID, &r.Name, &r.ProviderKey, &r.APIKeyEnc, &r.ExtraEnc, &r.LastUsedAt, &r.CreatedAt, &r.UpdatedAt}
}

// validateCredentialInput 复刻 validateCredentialInput。
func validateCredentialInput(raw map[string]any, requireAPIKey bool) (
	name string, providerKey *string, apiKey string, extra map[string]string, err error) {
	name = strings.TrimSpace(flexToString(raw["name"]))
	if name == "" {
		return "", nil, "", nil, badRequestMsg("凭证名称不能为空")
	}
	if runeLen(name) > 64 {
		return "", nil, "", nil, badRequestMsg("凭证名称不能超过 64 个字符")
	}

	providerKeyRaw := optionalString(raw["providerKey"])
	if providerKeyRaw != nil && FindProvider(*providerKeyRaw) == nil {
		return "", nil, "", nil, badRequestMsg("未知的供应商：%s", *providerKeyRaw)
	}

	apiKey = strings.TrimSpace(flexToString(raw["apiKey"]))
	if requireAPIKey && apiKey == "" {
		return "", nil, "", nil, badRequestMsg("API Key 不能为空")
	}
	return name, providerKeyRaw, apiKey, parseStringMap(raw["extra"]), nil
}

func runeLen(s string) int { return len([]rune(s)) }

// encodeExtra 复刻 encodeExtra：整体 JSON 后加密，空字典存 NULL。
func encodeExtra(extra map[string]string) (*string, error) {
	filtered := map[string]string{}
	for k, v := range extra {
		if strings.TrimSpace(v) != "" {
			filtered[k] = v
		}
	}
	if len(filtered) == 0 {
		return nil, nil
	}
	enc, err := aicore.EncodeExtra(filtered)
	if err != nil {
		return nil, err
	}
	return &enc, nil
}

// buildCredentialResponse 复刻 buildCredentialResponse：掩码 Key + 额外字段名清单。
func buildCredentialResponse(rec credentialRow, usageCount int64) gin.H {
	plain := aicore.DecodeApiKey(rec.APIKeyEnc)
	provider := FindProvider(rec.ProviderKey)

	var providerName any
	if provider != nil {
		providerName = provider.Name
	}

	extra := aicore.DecodeExtra(derefStr(rec.ExtraEnc))
	extraKeys := make([]string, 0, len(extra))
	for k := range extra {
		extraKeys = append(extraKeys, k)
	}
	sort.Strings(extraKeys)

	var lastUsedAt any
	if rec.LastUsedAt != nil {
		lastUsedAt = httpx.FormatISO(*rec.LastUsedAt)
	}

	return gin.H{
		"id":           idStr(rec.ID),
		"name":         rec.Name,
		"providerKey":  rec.ProviderKey,
		"providerName": providerName,
		"apiKeyMasked": aicore.MaskApiKey(plain),
		"extraKeys":    extraKeys,
		"usageCount":   usageCount,
		"lastUsedAt":   lastUsedAt,
		"createdAt":    httpx.FormatISO(rec.CreatedAt),
		"updatedAt":    httpx.FormatISO(rec.UpdatedAt),
	}
}

func findOwnedCredential(ctx context.Context, userID, id int64) (credentialRow, error) {
	var rec credentialRow
	err := db.Pool().QueryRow(ctx,
		`SELECT `+credentialCols+` FROM petrichor_ai_credential WHERE id = $1 AND user_id = $2 LIMIT 1`,
		id, userID).Scan(rec.scanInto()...)
	if err == pgx.ErrNoRows {
		return rec, httpx.NotFound("凭证不存在")
	}
	return rec, err
}

// ensureUniqueCredentialName 复刻 ensureUniqueName；excludeID 为 0 表示新建场景。
func ensureUniqueCredentialName(ctx context.Context, userID int64, name string, excludeID int64) error {
	rows, err := db.Pool().Query(ctx,
		`SELECT id FROM petrichor_ai_credential WHERE user_id = $1 AND name = $2 LIMIT 2`,
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
			return badRequestMsg("已存在同名凭证")
		}
	}
	return rows.Err()
}

// ListCredentials POST /api/ai/credential/list。
func ListCredentials(c *gin.Context) {
	user := auth.CurrentUser(c)
	ctx := c.Request.Context()
	pool := db.Pool()

	usageRows, err := pool.Query(ctx,
		`SELECT credential_id, count(*) FROM petrichor_ai_provider WHERE user_id = $1 GROUP BY credential_id`,
		user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	usage := map[int64]int64{}
	for usageRows.Next() {
		var credentialID, total int64
		if err := usageRows.Scan(&credentialID, &total); err != nil {
			usageRows.Close()
			httpx.HandleError(c, err)
			return
		}
		usage[credentialID] = total
	}
	usageRows.Close()
	if usageRows.Err() != nil {
		httpx.HandleError(c, usageRows.Err())
		return
	}

	rows, err := pool.Query(ctx,
		`SELECT `+credentialCols+` FROM petrichor_ai_credential WHERE user_id = $1
		 ORDER BY updated_at DESC, id DESC`, user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var rec credentialRow
		if err := rows.Scan(rec.scanInto()...); err != nil {
			httpx.HandleError(c, err)
			return
		}
		items = append(items, buildCredentialResponse(rec, usage[rec.ID]))
	}
	httpx.OK(c, gin.H{"items": items})
}

// CreateCredential POST /api/ai/credential/create。
func CreateCredential(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	name, providerKey, apiKey, extra, err := validateCredentialInput(body, true)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if err := ensureUniqueCredentialName(ctx, user.ID, name, 0); err != nil {
		httpx.HandleError(c, err)
		return
	}
	keyEnc, err := aicore.EncodeApiKey(apiKey)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	extraEnc, err := encodeExtra(extra)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	var rec credentialRow
	err = db.Pool().QueryRow(ctx,
		`INSERT INTO petrichor_ai_credential (user_id, name, provider_key, api_key_enc, extra_enc)
		 VALUES ($1, $2, $3, $4, $5) RETURNING `+credentialCols,
		user.ID, name, providerKey, keyEnc, extraEnc).Scan(rec.scanInto()...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, buildCredentialResponse(rec, 0))
}

// UpdateCredential POST /api/ai/credential/update。
// apiKey 留空表示不改（避免编辑其它字段时被迫重新粘贴 Key）；extra 没传沿用旧值，传了整体覆盖。
func UpdateCredential(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	id, err := requireID(body["id"], "凭证 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	existing, err := findOwnedCredential(ctx, user.ID, id)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	merged := map[string]any{"name": orElse(body["name"], existing.Name)}
	name, providerKey, apiKey, extra, err := validateCredentialInput(merged, false)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if name != existing.Name {
		if err := ensureUniqueCredentialName(ctx, user.ID, name, id); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}
	if len(extra) == 0 {
		extra = aicore.DecodeExtra(derefStr(existing.ExtraEnc))
	}
	extraEnc, err := encodeExtra(extra)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	keyEnc := existing.APIKeyEnc
	if apiKey != "" {
		enc, encErr := aicore.EncodeApiKey(apiKey)
		if encErr != nil {
			httpx.HandleError(c, encErr)
			return
		}
		keyEnc = enc
	}

	var rec credentialRow
	err = db.Pool().QueryRow(ctx,
		`UPDATE petrichor_ai_credential SET name = $1, provider_key = $2, api_key_enc = $3, extra_enc = $4, updated_at = $5
		 WHERE id = $6 AND user_id = $7 RETURNING `+credentialCols,
		name, providerKey, keyEnc, extraEnc, time.Now(), id, user.ID).Scan(rec.scanInto()...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, buildCredentialResponse(rec, 0))
}

// DeleteCredential POST /api/ai/credential/delete：被供应商引用时拒绝删除。
func DeleteCredential(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	id, err := requireID(body["id"], "凭证 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if _, err := findOwnedCredential(ctx, user.ID, id); err != nil {
		httpx.HandleError(c, err)
		return
	}

	var inUse int64
	if err := db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM petrichor_ai_provider WHERE user_id = $1 AND credential_id = $2`,
		user.ID, id).Scan(&inUse); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if inUse > 0 {
		httpx.HandleError(c, badRequestMsg("该凭证正被 %d 个供应商使用，请先解除引用再删除", inUse))
		return
	}

	if _, err := db.Pool().Exec(ctx,
		`DELETE FROM petrichor_ai_credential WHERE id = $1 AND user_id = $2`, id, user.ID); err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Status(200)
}

// orElse 复刻 ?? 语义：null/undefined 时取 fallback。
func orElse(v any, fallback any) any {
	if v == nil {
		return fallback
	}
	return v
}
