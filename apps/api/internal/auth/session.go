package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const userCtxKey = "petrichor.user"

// UserColumns petrichor_user 全列（顺序与 scanUser 对应）。
const UserColumns = `id, auth_user_id, email, password_hash, system_role, user_type,
	linuxdo_account_id, linuxdo_username, linuxdo_email, username, nickname, avatar, signature,
	created_at, updated_at`

// ScanUser 按UserColumns 顺序扫描一行用户。
func ScanUser(row pgx.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.AuthUserID, &u.Email, &u.PasswordHash, &u.SystemRole, &u.UserType,
		&u.LinuxDoAccountID, &u.LinuxDoUsername, &u.LinuxDoEmail, &u.Username, &u.Nickname,
		&u.Avatar, &u.Signature, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CurrentUser 从 gin 上下文取当前用户（RequireUser 之后可用）。
func CurrentUser(c *gin.Context) *User {
	v, ok := c.Get(userCtxKey)
	if !ok {
		return nil
	}
	u, _ := v.(*User)
	return u
}

func setSessionCookie(c *gin.Context, name, value string, maxAge int) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   config.IsProduction(),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearSessionCookie 登出时清 cookie。
func ClearSessionCookie(c *gin.Context, name string) {
	setSessionCookie(c, name, "", 0)
}

// EnsurePetrichorUserForBetterAuthUser 复刻 better-auth-bridge.ts 同名函数：
// 按 auth_user_id 找 → 按 email 关联更新 → 都没有则新建（首位用户自动 SUPER_ADMIN）。
func EnsurePetrichorUserForBetterAuthUser(authUserID, email, name string, image *string) (*User, error) {
	pool := db.Pool()
	normalizedEmail := normalizeEmail(email)
	displayName := name
	if displayName == "" {
		if idx := strings.IndexByte(normalizedEmail, '@'); idx > 0 {
			displayName = normalizedEmail[:idx]
		} else {
			displayName = normalizedEmail
		}
	}

	ctx := context.Background()
	row := pool.QueryRow(ctx,
		`SELECT `+UserColumns+` FROM petrichor_user WHERE auth_user_id = $1 LIMIT 1`, authUserID)
	u, err := ScanUser(row)
	if err == nil {
		return u, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	row = pool.QueryRow(ctx,
		`SELECT `+UserColumns+` FROM petrichor_user WHERE lower(email) = $1 LIMIT 1`, normalizedEmail)
	u, err = ScanUser(row)
	if err == nil {
		_, uerr := pool.Exec(ctx,
			`UPDATE petrichor_user SET auth_user_id = $1, avatar = COALESCE(NULLIF(avatar,''), $2), updated_at = now() WHERE id = $3`,
			authUserID, image, u.ID)
		if uerr != nil {
			return nil, uerr
		}
		return ScanUser(pool.QueryRow(ctx, `SELECT `+UserColumns+` FROM petrichor_user WHERE id = $1`, u.ID))
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	var cnt int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM petrichor_user WHERE system_role = 'SUPER_ADMIN'`).Scan(&cnt); err != nil {
		return nil, err
	}
	role := "USER"
	if cnt == 0 {
		role = "SUPER_ADMIN"
	}
	_, ierr := pool.Exec(ctx,
		`INSERT INTO petrichor_user (auth_user_id, email, password_hash, system_role, user_type, username, nickname, avatar)
		 VALUES ($1, $2, '', $3, 'LOCAL', $4, $4, $5)`,
		authUserID, normalizedEmail, role, displayName, image)
	if ierr != nil {
		return nil, ierr
	}
	return ScanUser(pool.QueryRow(ctx,
		`SELECT `+UserColumns+` FROM petrichor_user WHERE lower(email) = $1 LIMIT 1`, normalizedEmail))
}

// getCurrentUserViaBetterAuth 复刻 current-user.ts 的 Better Auth 通道。
func getCurrentUserViaBetterAuth(c *gin.Context) (*User, bool) {
	cfg := config.Get()
	name := BetterAuthCookieName(config.IsProduction())
	raw, err := c.Cookie(name)
	if err != nil || raw == "" {
		return nil, false
	}
	token, ok := VerifyBetterAuthCookieValue(raw, cfg.SessionSecret)
	if !ok {
		return nil, false
	}

	pool := db.Pool()
	ctx := context.Background()
	var (
		sessionID     string
		authUserID    string
		authUserEmail string
		authUserName  *string
		authUserImage *string
	)
	qerr := pool.QueryRow(ctx,
		`SELECT s.id, bu.id, bu.email, bu.name, bu.image
		 FROM better_auth_session s JOIN better_auth_user bu ON bu.id = s.user_id
		 WHERE s.token = $1 AND s.expires_at > now() LIMIT 1`, token).
		Scan(&sessionID, &authUserID, &authUserEmail, &authUserName, &authUserImage)
	if qerr != nil {
		return nil, false
	}

	// 主动续期并刷新 cookie（复刻 current-user.ts）
	_, _ = pool.Exec(ctx,
		`UPDATE better_auth_session SET expires_at = $1, updated_at = now() WHERE id = $2`,
		time.Now().Add(cfg.SessionExpire), sessionID)
	setSessionCookie(c, name, raw, int(cfg.SessionExpire.Seconds()))

	u, uerr := EnsurePetrichorUserForBetterAuthUser(authUserID, authUserEmail, deref(authUserName), authUserImage)
	if uerr != nil {
		return nil, false
	}
	return u, true
}

// getCurrentUserViaLocalSession 复刻自建 token 会话通道（cookie 或 Bearer）。
func getCurrentUserViaLocalSession(c *gin.Context) (*User, bool) {
	token, _ := c.Cookie(SessionCookieName)
	if token == "" {
		token = BearerToken(c)
	}
	if token == "" {
		return nil, false
	}
	tokenHash := HashSessionToken(token)

	pool := db.Pool()
	ctx := context.Background()
	var sessionID int64
	row := pool.QueryRow(ctx,
		`SELECT s.id, `+userJoinColumns()+`
		 FROM petrichor_auth_session s JOIN petrichor_user u ON u.id = s.user_id
		 WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
		 LIMIT 1`, tokenHash)
	var u User
	serr := row.Scan(&sessionID, &u.ID, &u.AuthUserID, &u.Email, &u.PasswordHash, &u.SystemRole, &u.UserType,
		&u.LinuxDoAccountID, &u.LinuxDoUsername, &u.LinuxDoEmail, &u.Username, &u.Nickname,
		&u.Avatar, &u.Signature, &u.CreatedAt, &u.UpdatedAt)
	if serr != nil {
		return nil, false
	}

	expire := time.Now().Add(config.Get().SessionExpire)
	_, _ = pool.Exec(ctx,
		`UPDATE petrichor_auth_session SET expires_at = $1, last_seen_at = now(), updated_at = now() WHERE id = $2`,
		expire, sessionID)
	cookieToken, hasCookie := c.Cookie(SessionCookieName)
	if hasCookie == nil && cookieToken == token && token != "" {
		setSessionCookie(c, SessionCookieName, token, int(config.Get().SessionExpire.Seconds()))
	}
	return &u, true
}

// BearerToken 提取 Authorization: Bearer <token>。
func BearerToken(c *gin.Context) string {
	raw := c.GetHeader("Authorization")
	const prefix = "Bearer "
	if len(raw) > len(prefix) && raw[:len(prefix)] == prefix {
		return raw[len(prefix):]
	}
	return ""
}

func userJoinColumns() string {
	return `u.id, u.auth_user_id, u.email, u.password_hash, u.system_role, u.user_type,
	u.linuxdo_account_id, u.linuxdo_username, u.linuxdo_email, u.username, u.nickname, u.avatar, u.signature,
	u.created_at, u.updated_at`
}

// GetCurrentUser 复刻 getCurrentUser：先 Better Auth 通道，再自建会话通道。
func GetCurrentUser(c *gin.Context) (*User, bool) {
	if u, ok := getCurrentUserViaBetterAuth(c); ok {
		return u, true
	}
	return getCurrentUserViaLocalSession(c)
}

// RequireUser 需登录中间件。
func RequireUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		u, ok := GetCurrentUser(c)
		if !ok {
			httpx.ErrorJSON(c, http.StatusUnauthorized, "请先登录")
			return
		}
		c.Set(userCtxKey, u)
		c.Next()
	}
}

// RequireSuperAdmin 超管中间件（须在 RequireUser 之后）。
func RequireSuperAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		u := CurrentUser(c)
		if u == nil || !u.IsSuperAdmin() {
			httpx.ErrorJSON(c, http.StatusForbidden, "无权限访问")
			return
		}
		c.Next()
	}
}
