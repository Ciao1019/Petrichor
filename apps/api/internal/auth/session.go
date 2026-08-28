package auth

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const userCtxKey = "petrichor.user"

// UserColumns petrichor_user 全列（顺序与 ScanUser 对应）。
const UserColumns = `id, email, password_hash, system_role, user_type,
	linuxdo_account_id, linuxdo_username, linuxdo_email, username, nickname, avatar, signature,
	created_at, updated_at`

// ScanUser 按 UserColumns 顺序扫描一行用户。
func ScanUser(row pgx.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.SystemRole, &u.UserType,
		&u.LinuxDoAccountID, &u.LinuxDoUsername, &u.LinuxDoEmail, &u.Username, &u.Nickname,
		&u.Avatar, &u.Signature, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CurrentUser 从 Gin 上下文取当前用户（RequireUser 之后可用）。
func CurrentUser(c *gin.Context) *User {
	v, ok := c.Get(userCtxKey)
	if !ok {
		return nil
	}
	u, _ := v.(*User)
	return u
}

func getCurrentUserViaLocalDevelopment() (*User, bool) {
	localAuth := config.Get().LocalDevelopmentAuth
	if !localAuth.Enabled {
		return nil, false
	}
	u, err := ScanUser(db.Pool().QueryRow(
		context.Background(),
		`SELECT `+UserColumns+` FROM petrichor_user WHERE id = $1 LIMIT 1`,
		localAuth.UserID,
	))
	if err != nil {
		slog.Error("本地免登录账号读取失败", "userId", localAuth.UserID, "err", err)
		return nil, false
	}
	return u, true
}

func getCurrentUserViaSaToken(c *gin.Context) (*User, bool) {
	token := currentSaToken(c)
	if token == "" {
		return nil, false
	}
	manager, _ := managerAndPlugin()
	loginID, err := manager.GetLoginID(token)
	if err != nil {
		return nil, false
	}
	userID, err := strconv.ParseInt(loginID, 10, 64)
	if err != nil || userID <= 0 {
		_ = manager.LogoutByToken(token)
		return nil, false
	}
	u, err := ScanUser(db.Pool().QueryRow(c.Request.Context(),
		`SELECT `+UserColumns+` FROM petrichor_user WHERE id = $1 LIMIT 1`, userID))
	if err != nil {
		_ = manager.LogoutByToken(token)
		return nil, false
	}
	renewSaTokenActivity(token)
	return u, true
}

// GetCurrentUser 依次尝试本地开发免登录与 Sa-Token 登录。
func GetCurrentUser(c *gin.Context) (*User, bool) {
	if u, ok := getCurrentUserViaLocalDevelopment(); ok {
		return u, true
	}
	return getCurrentUserViaSaToken(c)
}

// RequireUser 需登录中间件。
func RequireUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		required, err := SiteSetupRequired(c.Request.Context())
		if err != nil {
			httpx.HandleError(c, err)
			c.Abort()
			return
		}
		if required {
			httpx.ErrorJSON(c, http.StatusConflict, "请先完成管理员初始化")
			c.Abort()
			return
		}
		u, ok := GetCurrentUser(c)
		if !ok {
			httpx.ErrorJSON(c, http.StatusUnauthorized, "请先登录")
			c.Abort()
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
			c.Abort()
			return
		}
		c.Next()
	}
}
