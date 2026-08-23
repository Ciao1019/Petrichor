package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// Agent API Key 体系，复刻 src/server/agent/api-key.ts。

var AgentApiKeyScopes = []string{
	"article:write",
	"article:delete",
	"doc:read",
	"qa:read",
	"share:write",
	"ai:write",
	"wiki:read",
	"wiki:write",
}

var scopeSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(AgentApiKeyScopes))
	for _, s := range AgentApiKeyScopes {
		m[s] = struct{}{}
	}
	return m
}()

// AgentAuthContext Agent Key 鉴权上下文。
type AgentAuthContext struct {
	ApiKeyID   int64
	KeyPrefix  string
	Scopes     []string
	UserID     int64
}

const agentKeyCtx = "petrichor.agentAuth"

// GenerateAgentApiKey 生成 ptc_live_ 前缀 key。
func GenerateAgentApiKey() string {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	return "ptc_live_" + base64.RawURLEncoding.EncodeToString(buf)
}

// ToAgentApiKeyPrefix 前 16 位 + "..."。
func ToAgentApiKeyPrefix(apiKey string) string {
	trimmed := strings.TrimSpace(apiKey)
	return trimmed[:16] + "..."
}

// ExtractAgentBearerToken Authorization Bearer 或 x-petrichor-api-key。
func ExtractAgentBearerToken(c *gin.Context) string {
	authz := strings.TrimSpace(c.GetHeader("Authorization"))
	if len(authz) > 7 && strings.EqualFold(authz[:7], "Bearer ") {
		token := strings.TrimSpace(authz[7:])
		if token != "" {
			return token
		}
	}
	return strings.TrimSpace(c.GetHeader("x-petrichor-api-key"))
}

// ParseAgentScopes 解析 scopes JSON 数组。
func ParseAgentScopes(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var arr []any
	if err := json.Unmarshal([]byte(*raw), &arr); err != nil {
		return []string{}
	}
	scopes := make([]string, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if ok {
			if _, valid := scopeSet[s]; valid {
				scopes = append(scopes, s)
			}
		}
	}
	return scopes
}

// HasAgentScope 校验权限。
func HasAgentScope(scopes []string, required string) bool {
	for _, s := range scopes {
		if s == required {
			return true
		}
	}
	return false
}

func storeAgentCtx(c *gin.Context, actx *AgentAuthContext) { c.Set(agentKeyCtx, actx) }

// AgentAuth 从上下文取 Agent 鉴权信息。
func AgentAuth(c *gin.Context) *AgentAuthContext {
	v, _ := c.Get(agentKeyCtx)
	actx, _ := v.(*AgentAuthContext)
	return actx
}

// RequireAgentKey Agent API Key 鉴权中间件。
func RequireAgentKey(requiredScope string) gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := ExtractAgentBearerToken(c)
		if apiKey == "" {
			httpx.ErrorJSON(c, 401, "缺少 Agent API Key")
			return
		}
		keyHash := HashAgentApiKey(apiKey)
		ctx := context.Background()
		pool := db.Pool()
		var (
			id        int64
			userID    int64
			keyPrefix string
			scopesRaw *string
			expiresAt *time.Time
		)
		err := pool.QueryRow(ctx,
			`SELECT id, user_id, key_prefix, scopes_json, expires_at
			 FROM petrichor_agent_api_key
			 WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
			 LIMIT 1`, keyHash).
			Scan(&id, &userID, &keyPrefix, &scopesRaw, &expiresAt)
		if err != nil {
			httpx.ErrorJSON(c, 401, "Agent API Key 无效或已过期")
			return
		}
		_, _ = pool.Exec(ctx,
			`UPDATE petrichor_agent_api_key SET last_used_at = now(), updated_at = now() WHERE id = $1`, id)

		scopes := ParseAgentScopes(scopesRaw)
		if requiredScope != "" && !HasAgentScope(scopes, requiredScope) {
			httpx.ErrorJSON(c, 403, "当前 API Key 缺少 "+requiredScope+" 权限")
			return
		}
		storeAgentCtx(c, &AgentAuthContext{
			ApiKeyID:  id,
			KeyPrefix: keyPrefix,
			Scopes:    scopes,
			UserID:    userID,
		})
		c.Next()
	}
}
