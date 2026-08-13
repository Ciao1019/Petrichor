package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/agentapikey"
	"github.com/Ciao1019/Petrichor/apps/api/ent/agentcalllog"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/kb"
)

var agentAPIKeyScopes = []string{
	"article:write", "article:delete", "doc:read", "qa:read",
	"share:write", "ai:write", "wiki:read", "wiki:write",
}

var agentAPIKeyScopeSet = func() map[string]bool {
	out := make(map[string]bool, len(agentAPIKeyScopes))
	for _, scope := range agentAPIKeyScopes {
		out[scope] = true
	}
	return out
}()

type Handler struct {
	client *ent.Client
	kbSvc  *kb.Service
	gen    *ai.Generation
	cfg    *config.Config
}

func NewHandler(client *ent.Client, kbSvc *kb.Service, cfg *config.Config) *Handler {
	return &Handler{client: client, kbSvc: kbSvc, gen: ai.NewGeneration(cfg), cfg: cfg}
}

type APIKeyDTO struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	KeyPrefix  string   `json:"keyPrefix"`
	Scopes     []string `json:"scopes"`
	ExpiresAt  *string  `json:"expiresAt"`
	LastUsedAt *string  `json:"lastUsedAt"`
	RevokedAt  *string  `json:"revokedAt"`
	CreatedAt  *string  `json:"createdAt"`
	UpdatedAt  *string  `json:"updatedAt"`
}

func parseScopes(raw string) []string {
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, scope := range values {
		if agentAPIKeyScopeSet[scope] {
			out = append(out, scope)
		}
	}
	return out
}

func toKeyDTO(row *ent.AgentAPIKey) APIKeyDTO {
	return APIKeyDTO{
		ID: fmt.Sprintf("%d", row.ID), Name: row.Name, KeyPrefix: row.KeyPrefix,
		Scopes: parseScopes(row.ScopesJSON), ExpiresAt: formatOptionalTime(row.ExpiresAt),
		LastUsedAt: formatOptionalTime(row.LastUsedAt), RevokedAt: formatOptionalTime(row.RevokedAt),
		CreatedAt: formatTime(row.CreatedAt), UpdatedAt: formatTime(row.UpdatedAt),
	}
}

func formatTime(value time.Time) *string {
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func (h *Handler) ListAPIKeys(c *gin.Context) {
	u := auth.MustUser(c)
	now := time.Now().UTC()
	rows, err := h.client.AgentAPIKey.Query().Where(
		agentapikey.UserIDEQ(u.ID),
		agentapikey.RevokedAtIsNil(),
		agentapikey.Or(agentapikey.ExpiresAtIsNil(), agentapikey.ExpiresAtGT(now)),
	).Order(ent.Desc(agentapikey.FieldCreatedAt), ent.Desc(agentapikey.FieldID)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]APIKeyDTO, 0, len(rows))
	for _, row := range rows {
		items = append(items, toKeyDTO(row))
	}
	response.OK(c, gin.H{"items": items})
}

type createKeyRequest struct {
	Name      *string  `json:"name"`
	Scopes    []string `json:"scopes"`
	ExpiresAt *string  `json:"expiresAt"`
}

func (h *Handler) CreateAPIKey(c *gin.Context) {
	var req createKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	name := "Agent Skill Key"
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
	}
	if name == "" {
		response.Fail(c, response.BadRequest("name 不能为空"))
		return
	}
	if utf8.RuneCountInString(name) > 80 {
		response.Fail(c, response.BadRequest("name 不能超过 80 个字符"))
		return
	}
	scopes := req.Scopes
	if scopes == nil {
		scopes = append([]string(nil), agentAPIKeyScopes...)
	}
	for _, scope := range scopes {
		if !agentAPIKeyScopeSet[scope] {
			response.Fail(c, response.BadRequest("scopes 包含不支持的权限: "+scope))
			return
		}
	}
	var expiresAt *time.Time
	if req.ExpiresAt != nil {
		if strings.TrimSpace(*req.ExpiresAt) == "" {
			response.Fail(c, response.BadRequest("expiresAt 必须是合法时间"))
			return
		}
		value, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*req.ExpiresAt))
		if err != nil {
			response.Fail(c, response.BadRequest("expiresAt 必须是合法时间"))
			return
		}
		value = value.UTC()
		if !value.After(time.Now().UTC()) {
			response.Fail(c, response.BadRequest("expiresAt 必须晚于当前时间"))
			return
		}
		expiresAt = &value
	}

	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		response.Fail(c, err)
		return
	}
	secret := "ptc_live_" + base64.RawURLEncoding.EncodeToString(random)
	sum := sha256.Sum256([]byte(secret))
	scopesJSON, _ := json.Marshal(scopes)
	u := auth.MustUser(c)
	create := h.client.AgentAPIKey.Create().
		SetUserID(u.ID).
		SetName(name).
		SetKeyHash(hex.EncodeToString(sum[:])).
		SetKeyPrefix(secret[:16] + "...").
		SetScopesJSON(string(scopesJSON))
	if expiresAt != nil {
		create.SetExpiresAt(*expiresAt)
	}
	row, err := create.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"apiKey": secret, "item": toKeyDTO(row)})
}

func (h *Handler) RevokeAPIKey(c *gin.Context) {
	var req struct {
		ID agentID `json:"id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseAgentID(string(req.ID), "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.client.AgentAPIKey.Query().Where(
		agentapikey.IDEQ(id), agentapikey.UserIDEQ(u.ID), agentapikey.RevokedAtIsNil(),
	).Only(c.Request.Context())
	if ent.IsNotFound(err) {
		response.Fail(c, response.NotFound("API Key 不存在"))
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	row, err = row.Update().SetRevokedAt(time.Now().UTC()).Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"item": toKeyDTO(row)})
}

func (h *Handler) ListCallLogs(c *gin.Context) {
	u := auth.MustUser(c)
	var req struct {
		Limit int `json:"limit"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 30
	}
	if limit < 1 || limit > 100 {
		response.Fail(c, response.BadRequest("limit 必须在 1 到 100 之间"))
		return
	}
	rows, err := h.client.AgentCallLog.Query().
		Where(agentcalllog.UserIDEQ(u.ID)).
		Order(ent.Desc(agentcalllog.FieldCreatedAt), ent.Desc(agentcalllog.FieldID)).
		Limit(limit).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, gin.H{
			"id": fmt.Sprintf("%d", row.ID), "apiKeyId": fmt.Sprintf("%d", row.APIKeyID),
			"apiKeyPrefix": row.APIKeyPrefix, "method": row.Method, "path": row.Path,
			"ip": row.IP, "userAgent": row.UserAgent, "statusCode": row.StatusCode,
			"durationMs": row.DurationMs, "errorMessage": row.ErrorMessage,
			"request": parseLogPayload(row.RequestJSON), "response": parseLogPayload(row.ResponseJSON),
			"requestText": row.RequestJSON, "responseText": row.ResponseJSON,
			"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	response.OK(c, gin.H{"items": items})
}

func parseLogPayload(raw *string) any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(*raw), &value); err != nil {
		return *raw
	}
	return value
}

func parseAgentID(raw, field string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, response.BadRequest(field + " 无效")
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, response.BadRequest(field + " 无效")
		}
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, response.BadRequest(field + " 无效")
	}
	return id, nil
}
