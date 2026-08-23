// apikey.go 对照 handlers.ts 的用户态端点：api-key create/list/revoke 与 call-log/list。
package agentapi

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/auth"
)

const apiKeyColumns = `id, user_id, name, key_hash, key_prefix, scopes_json,
	expires_at, last_used_at, revoked_at, created_at, updated_at`

type apiKeyRow struct {
	ID         int64
	UserID     int64
	Name       string
	KeyHash    string
	KeyPrefix  string
	ScopesJSON string
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

func scanAPIKeyRow(rows pgx.Rows) (*apiKeyRow, error) {
	var r apiKeyRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.Name, &r.KeyHash, &r.KeyPrefix, &r.ScopesJSON,
		&r.ExpiresAt, &r.LastUsedAt, &r.RevokedAt, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

func toAgentApiKeyResponse(record *apiKeyRow) map[string]any {
	return map[string]any{
		"id":        idStr(record.ID),
		"name":      record.Name,
		"keyPrefix": record.KeyPrefix,
		"scopes":    auth.ParseAgentScopes(&record.ScopesJSON),
		"expiresAt": isoPtr(record.ExpiresAt),
		"lastUsedAt": func() any {
			if record.LastUsedAt == nil {
				return nil
			}
			return iso(*record.LastUsedAt)
		}(),
		"revokedAt": isoPtr(record.RevokedAt),
		"createdAt": iso(record.CreatedAt),
		"updatedAt": iso(record.UpdatedAt),
	}
}

// parseAgentApiKeyExpiresAt 对照 api-key.ts 同名函数。
func parseAgentApiKeyExpiresAt(value *string) (*time.Time, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	date, err := time.Parse(time.RFC3339, strings.TrimSpace(*value))
	if err != nil {
		return nil, badReq("expiresAt 必须是合法时间")
	}
	if !date.After(time.Now()) {
		return nil, badReq("expiresAt 必须晚于当前时间")
	}
	return &date, nil
}

// CreateAPIKey POST /api/agent/api-key/create。
func CreateAPIKey(c *gin.Context) (any, error) {
	user := auth.CurrentUser(c)
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}

	name := "Agent Skill Key"
	if v, ok := raw["name"]; ok && v != nil {
		if s, isStr := v.(string); isStr {
			name = strings.TrimSpace(s)
		} else {
			return nil, badReq("name 必须是字符串")
		}
	}
	if name == "" || len([]rune(name)) > 80 {
		return nil, badReq("name 长度必须在 1 到 80 之间")
	}

	scopes := append([]string{}, auth.AgentApiKeyScopes...)
	if v, ok := raw["scopes"]; ok && v != nil {
		list, isArr := v.([]any)
		if !isArr {
			return nil, badReq("scopes 必须是字符串数组")
		}
		scopes = scopes[:0]
		for _, item := range list {
			s, _ := item.(string)
			valid := false
			for _, candidate := range auth.AgentApiKeyScopes {
				if candidate == s {
					valid = true
					break
				}
			}
			if !valid {
				return nil, badReq("包含不支持的 scope：" + s)
			}
			scopes = append(scopes, s)
		}
	}

	var expiresAtInput *string
	if v, ok := raw["expiresAt"]; ok && v != nil {
		s, _ := v.(string)
		expiresAtInput = &s
	}
	expiresAt, err := parseAgentApiKeyExpiresAt(expiresAtInput)
	if err != nil {
		return nil, err
	}

	apiKey := auth.GenerateAgentApiKey()
	scopesJSON := marshalJSONString(scopes)
	ctx := context.Background()
	rows, ierr := dbPool().Query(ctx,
		`INSERT INTO petrichor_agent_api_key (user_id, name, key_hash, key_prefix, scopes_json, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING `+apiKeyColumns,
		user.ID, name, auth.HashAgentApiKey(apiKey), auth.ToAgentApiKeyPrefix(apiKey), scopesJSON, expiresAt)
	if ierr != nil {
		return nil, ierr
	}
	record, ierr := scanAPIKeyRow(rows)
	if ierr != nil {
		return nil, ierr
	}
	if record == nil {
		return nil, badReq("API Key 创建失败")
	}
	return map[string]any{
		"apiKey": apiKey,
		"item":   toAgentApiKeyResponse(record),
	}, nil
}

// ListAPIKeys POST /api/agent/api-key/list。
func ListAPIKeys(c *gin.Context) (any, error) {
	user := auth.CurrentUser(c)
	ctx := context.Background()
	rows, err := dbPool().Query(ctx,
		`SELECT `+apiKeyColumns+` FROM petrichor_agent_api_key
		 WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
		 ORDER BY created_at DESC, id DESC`, user.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		record, serr := scanAPIKeyRow(rows)
		if serr != nil {
			return nil, serr
		}
		items = append(items, toAgentApiKeyResponse(record))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

// RevokeAPIKey POST /api/agent/api-key/revoke。
func RevokeAPIKey(c *gin.Context) (any, error) {
	user := auth.CurrentUser(c)
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	id, err := reqID(raw["id"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	now := time.Now()
	rows, uerr := dbPool().Query(ctx,
		`UPDATE petrichor_agent_api_key SET revoked_at = $1, updated_at = $1
		 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
		 RETURNING `+apiKeyColumns,
		now, id, user.ID)
	if uerr != nil {
		return nil, uerr
	}
	record, rerr := scanAPIKeyRow(rows)
	if rerr != nil {
		return nil, rerr
	}
	if record == nil {
		return nil, notFoundErr("API Key 不存在")
	}
	return map[string]any{"item": toAgentApiKeyResponse(record)}, nil
}

// ListCallLogs POST /api/agent/call-log/list。
func ListCallLogs(c *gin.Context) (any, error) {
	user := auth.CurrentUser(c)
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	limit := int64(30)
	if v, ok := raw["limit"].(float64); ok && v > 0 && v <= 100 && float64(int64(v)) == v {
		limit = int64(v)
	}
	type logRow struct {
		ID          int64
		ApiKeyID    int64
		ApiKeyPref  string
		Method      string
		Path        string
		IP          *string
		UserAgent   *string
		RequestJSON *string
		ResponseJsn *string
		StatusCode  int32
		DurationMs  int32
		ErrorMsg    *string
		CreatedAt   time.Time
	}
	ctx := context.Background()
	rows, qerr := dbPool().Query(ctx,
		`SELECT id, api_key_id, api_key_prefix, method, path, ip, user_agent,
		        request_json, response_json, status_code, duration_ms, error_message, created_at
		 FROM petrichor_agent_call_log WHERE user_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT $2`, user.ID, limit)
	if qerr != nil {
		return nil, qerr
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var row logRow
		if err := rows.Scan(&row.ID, &row.ApiKeyID, &row.ApiKeyPref, &row.Method, &row.Path,
			&row.IP, &row.UserAgent, &row.RequestJSON, &row.ResponseJsn,
			&row.StatusCode, &row.DurationMs, &row.ErrorMsg, &row.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"id":           idStr(row.ID),
			"apiKeyId":     idStr(row.ApiKeyID),
			"apiKeyPrefix": row.ApiKeyPref,
			"method":       row.Method,
			"path":         row.Path,
			"ip":           row.IP,
			"userAgent":    row.UserAgent,
			"statusCode":   row.StatusCode,
			"durationMs":   row.DurationMs,
			"errorMessage": row.ErrorMsg,
			"request":      parseLogPayload(row.RequestJSON),
			"response":     parseLogPayload(row.ResponseJsn),
			"requestText":  row.RequestJSON,
			"responseText": row.ResponseJsn,
			"createdAt":    iso(row.CreatedAt),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

// parseLogPayload 对应 handlers.ts parseLogPayload：合法 JSON 解析为对象，否则原样返回字符串。
func parseLogPayload(raw *string) any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var parsed any
	if json.Unmarshal([]byte(*raw), &parsed) == nil {
		return parsed
	}
	return *raw
}

// marshalJSONString 序列化字符串数组（失败时退回空数组字面量）。
func marshalJSONString(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(raw)
}
