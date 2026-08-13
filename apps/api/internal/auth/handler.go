package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Handler struct {
	svc *Service
	cfg *config.Config
}

func NewHandler(svc *Service, cfg *config.Config) *Handler {
	return &Handler{svc: svc, cfg: cfg}
}

type loginRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

type registerRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=6"`
	Name     string `json:"name" binding:"required,min=1"`
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword" binding:"required"`
	NewPassword     string `json:"newPassword" binding:"required,min=6"`
}

// optionalNullableString 区分字段缺失与显式 null：旧接口允许用 null 清空资料字段。
type optionalNullableString struct {
	Present bool
	Value   *string
}

func (value *optionalNullableString) UnmarshalJSON(data []byte) error {
	value.Present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		value.Value = nil
		return nil
	}
	var decoded string
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	value.Value = &decoded
	return nil
}

type updateProfileRequest struct {
	Nickname  optionalNullableString `json:"nickname"`
	Avatar    optionalNullableString `json:"avatar"`
	Signature optionalNullableString `json:"signature"`
}

func (h *Handler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	result, _, token, err := h.svc.Login(c.Request.Context(), req.Email, req.Password, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setSessionCookie(c, token)
	response.OK(c, result)
}

func (h *Handler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	result, token, err := h.svc.Register(c.Request.Context(), req.Email, req.Password, name, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setSessionCookie(c, token)
	response.OK(c, result)
}

func (h *Handler) Logout(c *gin.Context) {
	token := ExtractToken(c, h.cfg.SessionCookieName)
	if err := h.svc.Logout(c.Request.Context(), token); err != nil {
		response.Fail(c, err)
		return
	}
	h.clearSessionCookie(c)
	response.OK(c, gin.H{})
}

func (h *Handler) Me(c *gin.Context) {
	u := MustUser(c)
	response.OK(c, ToUserDTO(u))
}

func (h *Handler) Profile(c *gin.Context) {
	u := MustUser(c)
	response.OK(c, ToProfileDTO(u))
}

func (h *Handler) UpdateProfile(c *gin.Context) {
	var req updateProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := MustUser(c)
	updated, err := h.svc.UpdateProfile(c.Request.Context(), u.ID, ProfilePatch{
		Nickname:  req.Nickname,
		Avatar:    req.Avatar,
		Signature: req.Signature,
	})
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, ToProfileDTO(updated))
}

func (h *Handler) ChangePassword(c *gin.Context) {
	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := MustUser(c)
	if err := h.svc.ChangePassword(c.Request.Context(), u.ID, req.CurrentPassword, req.NewPassword); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{})
}

type revokeSessionRequest struct {
	SessionID string `json:"sessionId" binding:"required"`
}

func (h *Handler) ListSessions(c *gin.Context) {
	u := MustUser(c)
	session := MustSession(c)
	result, err := h.svc.ListSessions(c.Request.Context(), u.ID, session.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, result)
}

func (h *Handler) RevokeSession(c *gin.Context) {
	var req revokeSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := MustUser(c)
	session := MustSession(c)
	if err := h.svc.RevokeSession(c.Request.Context(), u.ID, session.ID, req.SessionID); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"success": true})
}

func (h *Handler) RevokeOtherSessions(c *gin.Context) {
	u := MustUser(c)
	session := MustSession(c)
	n, err := h.svc.RevokeOtherSessions(c.Request.Context(), u.ID, session.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"success": true, "revokedCount": n})
}

func (h *Handler) setSessionCookie(c *gin.Context, token string) {
	secure := h.cfg.IsProduction()
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(
		h.cfg.SessionCookieName,
		token,
		int(h.cfg.SessionExpire.Seconds()),
		"/",
		"",
		secure,
		true,
	)
}

func (h *Handler) clearSessionCookie(c *gin.Context) {
	secure := h.cfg.IsProduction()
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(h.cfg.SessionCookieName, "", -1, "/", "", secure, true)
}

// ExtractToken 从 Cookie 或 Authorization Bearer 读取会话令牌。
func ExtractToken(c *gin.Context, cookieName string) string {
	if cookie, err := c.Cookie(cookieName); err == nil && strings.TrimSpace(cookie) != "" {
		return cookie
	}
	raw := strings.TrimSpace(c.GetHeader("Authorization"))
	if raw == "" {
		return ""
	}
	parts := strings.SplitN(raw, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func CookieMaxAge(expire time.Duration) int {
	return int(expire.Seconds())
}
