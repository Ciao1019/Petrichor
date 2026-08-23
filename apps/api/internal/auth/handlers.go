// 认证组处理器：移植 app/api/auth/* 与 better-auth-bridge.ts 的登录、注册、登出、
// 资料、改密等端点。按产品决策移除 2FA 流程：登录不再处理 twoFactorRedirect，
// 密码通过即发会话；twoFactorEnabled 恒 false。
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
	"time"

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

// newUUID 基于 crypto/rand 的 UUID v4。
func newUUID() string {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("生成随机数失败：%v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// requestIP 取 X-Forwarded-For 首段，缺失时回退 RemoteAddr。
func requestIP(c *gin.Context) string {
	if xff := strings.TrimSpace(c.GetHeader("X-Forwarded-For")); xff != "" {
		if idx := strings.IndexByte(xff, ','); idx >= 0 {
			xff = xff[:idx]
		}
		if ip := strings.TrimSpace(xff); ip != "" {
			return ip
		}
	}
	return c.RemoteIP()
}

// getSessionTokenRaw 自建会话通道取 token：cookie 优先，回退 Bearer。
func getSessionTokenRaw(c *gin.Context) string {
	if token, err := c.Cookie(SessionCookieName); err == nil && token != "" {
		return token
	}
	return BearerToken(c)
}

func findPetrichorUserByEmail(email string) (*User, error) {
	row := db.Pool().QueryRow(ctx(),
		`SELECT `+UserColumns+` FROM petrichor_user WHERE lower(email) = $1 LIMIT 1`, normalizeEmail(email))
	u, err := ScanUser(row)
	if err != nil {
		return nil, err
	}
	return u, nil
}

// ensureBetterAuthCredentialsForEmail 移植 better-auth-bridge.ts 同名函数：
// 把 petrichor_user 的凭据同步到 better_auth_user/better_auth_account，
// 保证后续登录走 credential 通道。返回解析后的 authUserId（无凭据时为 nil）。
func ensureBetterAuthCredentialsForEmail(email string) (*string, error) {
	pool := db.Pool()
	bg := ctx()
	normalizedEmail := normalizeEmail(email)

	u, err := findPetrichorUserByEmail(normalizedEmail)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if strings.TrimSpace(u.PasswordHash) == "" {
		return nil, nil
	}

	// 兼容历史数据：auth_user_id 缺失时用确定性 id 补建并回写。
	authUserID := strings.TrimSpace(deref(u.AuthUserID))
	if authUserID == "" {
		authUserID = "petrichor_" + strconv.FormatInt(u.ID, 10)
	}
	displayName := firstNonEmpty(deref(u.Nickname), deref(u.Username), normalizedEmail)

	if _, ierr := pool.Exec(bg,
		`INSERT INTO better_auth_user (id, name, email, email_verified, image, created_at, updated_at)
		 VALUES ($1, $2, $3, true, $4, $5, $6)
		 ON CONFLICT (email) DO NOTHING`,
		authUserID, displayName, normalizedEmail, u.Avatar, u.CreatedAt, u.UpdatedAt); ierr != nil {
		return nil, ierr
	}

	var resolvedID string
	if serr := pool.QueryRow(bg,
		`SELECT id FROM better_auth_user WHERE lower(email) = $1 LIMIT 1`, normalizedEmail).Scan(&resolvedID); serr != nil {
		if errors.Is(serr, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, serr
	}

	if deref(u.AuthUserID) != resolvedID {
		if _, uerr := pool.Exec(bg,
			`UPDATE petrichor_user SET auth_user_id = $1, updated_at = now() WHERE id = $2`,
			resolvedID, u.ID); uerr != nil {
			return nil, uerr
		}
	}

	var accountPassword *string
	aerr := pool.QueryRow(bg,
		`SELECT password FROM better_auth_account
		 WHERE provider_id = 'credential' AND account_id = $1 LIMIT 1`, resolvedID).Scan(&accountPassword)
	switch {
	case errors.Is(aerr, pgx.ErrNoRows):
		if _, ierr := pool.Exec(bg,
			`INSERT INTO better_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
			 VALUES ($1, $2, 'credential', $2, $3, $4, $5)
			 ON CONFLICT (provider_id, account_id) DO NOTHING`,
			"credential_"+strconv.FormatInt(u.ID, 10), resolvedID, u.PasswordHash, u.CreatedAt, u.UpdatedAt); ierr != nil {
			return nil, ierr
		}
	case aerr != nil:
		return nil, aerr
	case strings.TrimSpace(deref(accountPassword)) == "":
		if _, uerr := pool.Exec(bg,
			`UPDATE better_auth_account SET password = $1, updated_at = now()
			 WHERE provider_id = 'credential' AND account_id = $2`,
			u.PasswordHash, resolvedID); uerr != nil {
			return nil, uerr
		}
	}

	resolved := resolvedID
	return &resolved, nil
}

// createBetterAuthSession 创建 better_auth_session 并返回裸 token。
func createBetterAuthSession(authUserID, ip, userAgent string, ttl time.Duration) (string, error) {
	token := randomBase64URL(32)
	_, err := db.Pool().Exec(ctx(),
		`INSERT INTO better_auth_session (id, token, expires_at, user_id, ip_address, user_agent)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		newUUID(), token, time.Now().Add(ttl), authUserID, ip, userAgent)
	if err != nil {
		return "", err
	}
	return token, nil
}

// issuePetrichorSession 创建自建会话记录并返回裸 token（对应 issueSessionToken + 插入）。
func issuePetrichorSession(userID int64, ip, userAgent string) (string, error) {
	token := randomBase64URL(32)
	_, err := db.Pool().Exec(ctx(),
		`INSERT INTO petrichor_auth_session (token_hash, user_id, ip, user_agent, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		HashSessionToken(token), userID, ip, userAgent, time.Now().Add(config.Get().SessionExpire))
	if err != nil {
		return "", err
	}
	return token, nil
}

// setBetterAuthCookie 设置签名后的 Better Auth 会话 cookie。
func setBetterAuthCookie(c *gin.Context, bareToken string) {
	cfg := config.Get()
	setSessionCookie(c, BetterAuthCookieName(config.IsProduction()),
		SignBetterAuthCookieValue(bareToken, cfg.SessionSecret), int(cfg.SessionExpire.Seconds()))
}

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// Login POST /api/auth/login。2FA 已移除：密码通过直接发会话。
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

	if _, err := ensureBetterAuthCredentialsForEmail(email); err != nil {
		httpx.HandleError(c, err)
		return
	}

	pool := db.Pool()
	bg := context.Background()

	// 凭据校验优先走 better_auth_account.password，回退 petrichor_user.password_hash。
	var credPassword *string
	var credAuthUserID *string
	if err := pool.QueryRow(bg,
		`SELECT ba.password, bu.id
		 FROM better_auth_user bu
		 LEFT JOIN better_auth_account ba ON ba.user_id = bu.id AND ba.provider_id = 'credential'
		 WHERE lower(bu.email) = $1 LIMIT 1`, email).Scan(&credPassword, &credAuthUserID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.HandleError(c, err)
		return
	}

	u, uerr := findPetrichorUserByEmail(email)
	if uerr != nil {
		if errors.Is(uerr, pgx.ErrNoRows) {
			httpx.ErrorJSON(c, http.StatusUnauthorized, "邮箱或密码错误")
			return
		}
		httpx.HandleError(c, uerr)
		return
	}

	matched := false
	for _, hash := range []*string{credPassword, &u.PasswordHash} {
		if hash == nil || strings.TrimSpace(*hash) == "" {
			continue
		}
		if bcrypt.CompareHashAndPassword([]byte(*hash), []byte(password)) == nil {
			matched = true
			break
		}
	}
	if !matched {
		httpx.ErrorJSON(c, http.StatusUnauthorized, "邮箱或密码错误")
		return
	}

	authUserID := firstNonEmpty(deref(credAuthUserID), deref(u.AuthUserID),
		"petrichor_"+strconv.FormatInt(u.ID, 10))
	token, terr := createBetterAuthSession(authUserID, requestIP(c), c.Request.UserAgent(), config.Get().SessionExpire)
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	setBetterAuthCookie(c, token)
	httpx.OK(c, gin.H{"token": token, "user": u.ToUserResponse()})
}

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

// resolveSystemRoleForNewUser 移植 register-policy.ts：
// 请求 SUPER_ADMIN 直接给；否则无超管时首个用户 SUPER_ADMIN。
func resolveSystemRoleForNewUser(requestedRole string) (string, error) {
	if requestedRole == "SUPER_ADMIN" {
		return "SUPER_ADMIN", nil
	}
	var cnt int64
	if err := db.Pool().QueryRow(ctx(),
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

	requestedRole := strings.ToUpper(strings.TrimSpace(cfg.RegisterDefaultRole))
	if requestedRole != "USER" && requestedRole != "SUPER_ADMIN" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE 只支持 USER 或 SUPER_ADMIN")
		return
	}

	pool := db.Pool()
	bg := context.Background()

	// 邮箱唯一性需同时检查两张表（与 createLocalUserWithBetterAuth 一致）。
	var exists bool
	if err := pool.QueryRow(bg,
		`SELECT EXISTS(SELECT 1 FROM petrichor_user WHERE lower(email) = $1)
		      OR EXISTS(SELECT 1 FROM better_auth_user WHERE lower(email) = $1)`, email).Scan(&exists); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if exists {
		httpx.ErrorJSON(c, http.StatusBadRequest, "邮箱已被注册")
		return
	}

	systemRole, rerr := resolveSystemRoleForNewUser(requestedRole)
	if rerr != nil {
		httpx.HandleError(c, rerr)
		return
	}

	passwordHash, herr := bcrypt.GenerateFromPassword([]byte(password), 10)
	if herr != nil {
		httpx.HandleError(c, herr)
		return
	}

	authUserID := newUUID()
	localPart := strings.TrimSpace(strings.SplitN(email, "@", 2)[0])
	username := localPart
	if username == "" {
		username = name
	}

	tx, berr := pool.Begin(bg)
	if berr != nil {
		httpx.HandleError(c, berr)
		return
	}
	defer func() { _ = tx.Rollback(bg) }()

	if _, ierr := tx.Exec(bg,
		`INSERT INTO better_auth_user (id, name, email, email_verified, image) VALUES ($1, $2, $3, true, NULL)`,
		authUserID, name, email); ierr != nil {
		httpx.HandleError(c, ierr)
		return
	}
	if _, ierr := tx.Exec(bg,
		`INSERT INTO better_auth_account (id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $2, $3)`,
		newUUID(), authUserID, string(passwordHash)); ierr != nil {
		httpx.HandleError(c, ierr)
		return
	}

	u, ierr := ScanUser(tx.QueryRow(bg,
		`INSERT INTO petrichor_user (auth_user_id, email, password_hash, system_role, user_type, username, nickname)
		 VALUES ($1, $2, $3, $4, 'LOCAL', $5, $6) RETURNING `+UserColumns,
		authUserID, email, string(passwordHash), systemRole, username, name))
	if ierr != nil {
		httpx.HandleError(c, ierr)
		return
	}
	if cerr := tx.Commit(bg); cerr != nil {
		httpx.HandleError(c, cerr)
		return
	}

	// 注册后自动登录（对照 TS 注册路由里的 signInEmail）。
	token, terr := createBetterAuthSession(authUserID, requestIP(c), c.Request.UserAgent(), cfg.SessionExpire)
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	setBetterAuthCookie(c, token)
	httpx.OK(c, gin.H{"token": token, "user": u.ToUserResponse()})
}

// Logout POST /api/auth/logout：尽力撤销两条会话通道并清两类 cookie。
func Logout(c *gin.Context) {
	if token := getSessionTokenRaw(c); token != "" {
		_, _ = db.Pool().Exec(ctx(),
			`UPDATE petrichor_auth_session SET revoked_at = now(), updated_at = now()
			 WHERE token_hash = $1 AND revoked_at IS NULL`, HashSessionToken(token))
	}

	cookieName := BetterAuthCookieName(config.IsProduction())
	if raw, cerr := c.Cookie(cookieName); cerr == nil && raw != "" {
		if token, ok := VerifyBetterAuthCookieValue(raw, config.Get().SessionSecret); ok {
			_, _ = db.Pool().Exec(ctx(), `DELETE FROM better_auth_session WHERE token = $1`, token)
		}
	}

	ClearSessionCookie(c, SessionCookieName)
	ClearSessionCookie(c, cookieName)
	httpx.OK(c, gin.H{"success": true})
}

// Me GET /api/auth/me。
func Me(c *gin.Context) {
	httpx.OK(c, CurrentUser(c).ToUserResponse())
}

// Profile GET /api/auth/profile：twoFactorEnabled 恒 false（2FA 已移除）。
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

	u, uerr := ScanUser(db.Pool().QueryRow(ctx(), query, args...))
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

// ChangePassword POST /api/auth/password/change：
// 验旧密码 → 双写两张表 → 撤销本人其他自建会话（保留当前会话）。
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

	pool := db.Pool()
	bg := context.Background()

	// 验证旧密码：优先 petrichor_user.password_hash，回退 credential 账户密码。
	oldHash := ""
	if strings.TrimSpace(current.PasswordHash) != "" &&
		bcrypt.CompareHashAndPassword([]byte(current.PasswordHash), []byte(oldPassword)) == nil {
		oldHash = current.PasswordHash
	} else {
		var credPassword *string
		qerr := pool.QueryRow(bg,
			`SELECT ba.password FROM better_auth_account ba
			 WHERE ba.provider_id = 'credential' AND ba.user_id = $1 AND ba.password IS NOT NULL
			 LIMIT 1`, deref(current.AuthUserID)).Scan(&credPassword)
		if qerr == nil && credPassword != nil &&
			bcrypt.CompareHashAndPassword([]byte(*credPassword), []byte(oldPassword)) == nil {
			oldHash = *credPassword
		}
	}
	if oldHash == "" {
		httpx.ErrorJSON(c, http.StatusBadRequest, "当前密码错误")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(oldHash), []byte(newPassword)) == nil {
		httpx.ErrorJSON(c, http.StatusBadRequest, "新密码不能与当前密码相同")
		return
	}

	newHashBytes, herr := bcrypt.GenerateFromPassword([]byte(newPassword), 10)
	if herr != nil {
		httpx.HandleError(c, herr)
		return
	}
	newHash := string(newHashBytes)

	// 确保 better_auth 凭据链路存在（对齐 requireAuthUserIdForPetrichorUser + ensure 同步）。
	authUserID := strings.TrimSpace(deref(current.AuthUserID))
	if authUserID == "" {
		resolved, eerr := ensureBetterAuthCredentialsForEmail(current.Email)
		if eerr != nil {
			httpx.HandleError(c, eerr)
			return
		}
		if resolved == nil {
			httpx.ErrorJSON(c, http.StatusUnauthorized, "登录信息已失效")
			return
		}
		authUserID = *resolved
	}

	tx, berr := pool.Begin(bg)
	if berr != nil {
		httpx.HandleError(c, berr)
		return
	}
	defer func() { _ = tx.Rollback(bg) }()

	if _, uerr := tx.Exec(bg,
		`UPDATE petrichor_user SET password_hash = $1, updated_at = now() WHERE id = $2`,
		newHash, current.ID); uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	if _, aerr := tx.Exec(bg,
		`UPDATE better_auth_account SET password = $1, updated_at = now()
		 WHERE user_id = $2 AND provider_id = 'credential'`,
		newHash, authUserID); aerr != nil {
		httpx.HandleError(c, aerr)
		return
	}
	if cerr := tx.Commit(bg); cerr != nil {
		httpx.HandleError(c, cerr)
		return
	}

	// 撤销本人其他有效自建会话；当前 token 对应会话保留。
	if currentToken := getSessionTokenRaw(c); currentToken != "" {
		_, _ = pool.Exec(bg,
			`UPDATE petrichor_auth_session SET revoked_at = now(), updated_at = now()
			 WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
			current.ID, HashSessionToken(currentToken))
	}

	httpx.OK(c, gin.H{"success": true})
}
