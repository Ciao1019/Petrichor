// 认证组处理器：实现登录、注册、登出、资料和改密等端点。
// 密码通过后直接签发会话。
package auth

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

var emailPattern = regexp.MustCompile(`^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$`)

// randomBase64URL 生成 n 字节随机数的 base64url 字符串。
func randomBase64URL(n int) string {
	b := make([]byte, n)
	if _, err := cryptorand.Read(b); err != nil {
		panic(fmt.Sprintf("生成随机数失败：%v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// requestIP 仅通过 Gin 的可信代理链解析访客 IP；可信 CIDR 由 server.trusted_proxies 配置。
func requestIP(c *gin.Context) string {
	return strings.TrimSpace(c.ClientIP())
}

func findPetrichorUserByEmail(ctx context.Context, email string) (*User, error) {
	row := db.Pool().QueryRow(ctx,
		`SELECT `+UserColumns+` FROM petrichor_user WHERE lower(email) = $1 LIMIT 1`, normalizeEmail(email))
	u, err := ScanUser(row)
	if err != nil {
		return nil, err
	}
	return u, nil
}

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// Login POST /api/auth/login：密码通过后直接签发会话。
func Login(c *gin.Context) {
	var req credentialsRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	email := normalizeEmail(req.Email)
	password := req.Password
	if !emailPattern.MatchString(email) || strings.TrimSpace(password) == "" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "邮箱或密码错误")
		return
	}
	requestCtx := c.Request.Context()
	if err := enforceCredentialRateLimit(requestCtx, "login", email, requestIP(c)); err != nil {
		httpx.HandleError(c, err)
		return
	}

	u, uerr := findPetrichorUserByEmail(requestCtx, email)
	if uerr != nil {
		if errors.Is(uerr, pgx.ErrNoRows) {
			httpx.ErrorJSON(c, http.StatusUnauthorized, "邮箱或密码错误")
			return
		}
		httpx.HandleError(c, uerr)
		return
	}

	if strings.TrimSpace(u.PasswordHash) == "" ||
		bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) != nil {
		httpx.ErrorJSON(c, http.StatusUnauthorized, "邮箱或密码错误")
		return
	}

	token, terr := loginWithSaToken(c, u.ID)
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	clearCredentialIdentityRateLimit(requestCtx, "login", email)
	httpx.OK(c, gin.H{"token": token, "user": u.ToUserResponse()})
}

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

// resolveSystemRoleForNewUser 移植 register-policy.ts：
// 请求 SUPER_ADMIN 直接给；否则无超管时首个用户 SUPER_ADMIN。
func resolveSystemRoleForNewUser(ctx context.Context, requestedRole string) (string, error) {
	if requestedRole == "SUPER_ADMIN" {
		return "SUPER_ADMIN", nil
	}
	var cnt int64
	if err := db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM petrichor_user WHERE system_role = 'SUPER_ADMIN'`).Scan(&cnt); err != nil {
		return "", err
	}
	if cnt == 0 {
		return "SUPER_ADMIN", nil
	}
	return "USER", nil
}

// Register POST /api/auth/register。注册成功后自动登录并返回 {token, user}（与 TS 一致）。
func Register(c *gin.Context) {
	var req registerRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	email := normalizeEmail(req.Email)
	name := strings.TrimSpace(req.Name)
	password := req.Password
	if !emailPattern.MatchString(email) {
		httpx.ErrorJSON(c, http.StatusBadRequest, "邮箱格式不正确")
		return
	}
	if len(password) < 6 {
		httpx.ErrorJSON(c, http.StatusBadRequest, "密码长度至少为 6 位")
		return
	}
	if name == "" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "名称不能为空")
		return
	}

	cfg := config.Get()
	if !cfg.RegisterEnabled {
		httpx.ErrorJSON(c, http.StatusForbidden, "注册已关闭")
		return
	}

	requestCtx := c.Request.Context()
	if err := enforceCredentialRateLimit(requestCtx, "register", email, requestIP(c)); err != nil {
		httpx.HandleError(c, err)
		return
	}
	requestedRole := strings.ToUpper(strings.TrimSpace(cfg.RegisterDefaultRole))
	if requestedRole != "USER" && requestedRole != "SUPER_ADMIN" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE 只支持 USER 或 SUPER_ADMIN")
		return
	}

	pool := db.Pool()

	var exists bool
	if err := pool.QueryRow(requestCtx,
		`SELECT EXISTS(SELECT 1 FROM petrichor_user WHERE lower(email) = $1)`, email).Scan(&exists); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if exists {
		httpx.ErrorJSON(c, http.StatusBadRequest, "邮箱已被注册")
		return
	}

	systemRole, rerr := resolveSystemRoleForNewUser(requestCtx, requestedRole)
	if rerr != nil {
		httpx.HandleError(c, rerr)
		return
	}

	passwordHash, herr := bcrypt.GenerateFromPassword([]byte(password), 10)
	if herr != nil {
		httpx.HandleError(c, herr)
		return
	}

	localPart := strings.TrimSpace(strings.SplitN(email, "@", 2)[0])
	username := localPart
	if username == "" {
		username = name
	}

	u, ierr := ScanUser(pool.QueryRow(requestCtx,
		`INSERT INTO petrichor_user (email, password_hash, system_role, user_type, username, nickname)
		 VALUES ($1, $2, $3, 'LOCAL', $4, $5) RETURNING `+UserColumns,
		email, string(passwordHash), systemRole, username, name))
	if ierr != nil {
		httpx.HandleError(c, ierr)
		return
	}

	// 注册后由 Sa-Token 自动登录。
	token, terr := loginWithSaToken(c, u.ID)
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	httpx.OK(c, gin.H{"token": token, "user": u.ToUserResponse()})
}

// Logout POST /api/auth/logout：注销当前 Sa-Token 会话并清 Cookie。
func Logout(c *gin.Context) {
	if token := currentSaToken(c); token != "" {
		manager, _ := managerAndPlugin()
		_ = manager.LogoutByToken(token)
	}
	clearAuthTokenCookie(c)
	httpx.OK(c, gin.H{"success": true})
}

// Me GET /api/auth/me。
func Me(c *gin.Context) {
	httpx.OK(c, CurrentUser(c).ToUserResponse())
}

// Profile GET /api/auth/profile。
func Profile(c *gin.Context) {
	httpx.OK(c, CurrentUser(c).ToUserProfileResponse())
}

// ProfileUpdate POST /api/auth/profile/update：更新 nickname/avatar/signature（可显式置空）。
func ProfileUpdate(c *gin.Context) {
	current := CurrentUser(c)
	var body map[string]json.RawMessage
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}

	allowed := []string{"nickname", "avatar", "signature"}
	setClauses := make([]string, 0, len(allowed))
	args := make([]any, 0, len(allowed)+1)
	placeholder := 1
	for _, key := range allowed {
		raw, ok := body[key]
		if !ok {
			continue
		}
		value, verr := decodeNullableString(raw)
		if verr != nil {
			httpx.HandleError(c, verr)
			return
		}
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", key, placeholder))
		args = append(args, value)
		placeholder++
	}
	args = append(args, current.ID)
	// 无字段可更新时仅刷新 updated_at（与 TS 展开空对象的语义一致）。
	query := `UPDATE petrichor_user SET updated_at = now()`
	if len(setClauses) > 0 {
		query = `UPDATE petrichor_user SET ` + strings.Join(setClauses, ", ") + `, updated_at = now()`
	}
	query += ` WHERE id = $` + strconv.Itoa(placeholder) + ` RETURNING ` + UserColumns

	u, uerr := ScanUser(db.Pool().QueryRow(c.Request.Context(), query, args...))
	if uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	httpx.OK(c, u.ToUserProfileResponse())
}

func decodeNullableString(raw json.RawMessage) (*string, error) {
	if strings.TrimSpace(string(raw)) == "null" {
		return nil, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, httpx.BadRequest("请求参数错误")
	}
	trimmed := strings.TrimSpace(s)
	return &trimmed, nil
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	OldPassword     string `json:"oldPassword"`
	NewPassword     string `json:"newPassword"`
}

// ChangePassword POST /api/auth/password/change：验证旧密码、更新密码并下线其他设备。
func ChangePassword(c *gin.Context) {
	current := CurrentUser(c)
	var req changePasswordRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	oldPassword := firstNonEmpty(req.CurrentPassword, req.OldPassword)
	newPassword := req.NewPassword
	if oldPassword == "" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "当前密码错误")
		return
	}
	if len(newPassword) < 6 {
		httpx.ErrorJSON(c, http.StatusBadRequest, "新密码长度至少为 6 位")
		return
	}

	if strings.TrimSpace(current.PasswordHash) == "" ||
		bcrypt.CompareHashAndPassword([]byte(current.PasswordHash), []byte(oldPassword)) != nil {
		httpx.ErrorJSON(c, http.StatusBadRequest, "当前密码错误")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(current.PasswordHash), []byte(newPassword)) == nil {
		httpx.ErrorJSON(c, http.StatusBadRequest, "新密码不能与当前密码相同")
		return
	}

	newHashBytes, herr := bcrypt.GenerateFromPassword([]byte(newPassword), 10)
	if herr != nil {
		httpx.HandleError(c, herr)
		return
	}
	if _, uerr := db.Pool().Exec(c.Request.Context(),
		`UPDATE petrichor_user SET password_hash = $1, updated_at = now() WHERE id = $2`,
		string(newHashBytes), current.ID); uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}

	if _, err := logoutOtherSaTokenSessions(current.ID, currentSaToken(c)); err != nil {
		httpx.HandleError(c, err)
		return
	}

	httpx.OK(c, gin.H{"success": true})
}
