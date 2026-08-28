package auth

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const (
	initialAdminSetupLockKey  = int64(723_381_907)
	minimumSetupPasswordRunes = 8
)

var setupCompleteCached atomic.Bool

type setupRequest struct {
	Email    string `json:"email"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type normalizedSetupRequest struct {
	email    string
	username string
	password string
}

func normalizeSetupRequest(req setupRequest) (normalizedSetupRequest, error) {
	email := normalizeEmail(req.Email)
	username := strings.TrimSpace(req.Username)
	password := req.Password

	if !emailPattern.MatchString(email) {
		return normalizedSetupRequest{}, httpx.BadRequest("邮箱格式不正确")
	}
	usernameRunes := utf8.RuneCountInString(username)
	if usernameRunes < 2 || usernameRunes > 50 {
		return normalizedSetupRequest{}, httpx.BadRequest("管理员名称长度应为 2 到 50 个字符")
	}
	passwordRunes := utf8.RuneCountInString(password)
	if passwordRunes < minimumSetupPasswordRunes {
		return normalizedSetupRequest{}, httpx.BadRequest("密码长度至少为 8 位")
	}
	if passwordRunes > 128 {
		return normalizedSetupRequest{}, httpx.BadRequest("密码长度不能超过 128 位")
	}
	return normalizedSetupRequest{email: email, username: username, password: password}, nil
}

func siteHasSuperAdmin(ctx context.Context) (bool, error) {
	var exists bool
	err := db.Pool().QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM petrichor_user WHERE system_role = 'SUPER_ADMIN')`).Scan(&exists)
	return exists, err
}

// SiteSetupRequired 仅缓存“已完成”状态；未初始化时每次重新读取数据库。
func SiteSetupRequired(ctx context.Context) (bool, error) {
	if setupCompleteCached.Load() {
		return false, nil
	}
	complete, err := siteHasSuperAdmin(ctx)
	if err != nil {
		return false, err
	}
	if complete {
		setupCompleteCached.Store(true)
	}
	return !complete, nil
}

// RequireSiteInitialized 阻止未初始化站点使用普通登录入口。
func RequireSiteInitialized() gin.HandlerFunc {
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
		c.Next()
	}
}

// SetupStatus GET /api/auth/setup/status。
func SetupStatus(c *gin.Context) {
	required, err := SiteSetupRequired(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httpx.OK(c, gin.H{"required": required})
}

// Setup POST /api/auth/setup：只允许全新数据库创建第一个超级管理员。
func Setup(c *gin.Context) {
	var req setupRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	input, err := normalizeSetupRequest(req)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(input.password), bcrypt.DefaultCost)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	ctx := c.Request.Context()
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, initialAdminSetupLockKey); err != nil {
		httpx.HandleError(c, err)
		return
	}
	var superAdminExists bool
	if err = tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM petrichor_user WHERE system_role = 'SUPER_ADMIN')`).
		Scan(&superAdminExists); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if superAdminExists {
		httpx.HandleError(c, httpx.Conflict("站点已经完成初始化"))
		return
	}

	var emailExists bool
	if err = tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM petrichor_user WHERE lower(email) = $1)`, input.email).
		Scan(&emailExists); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if emailExists {
		httpx.HandleError(c, httpx.BadRequest("邮箱已被使用"))
		return
	}

	user, err := ScanUser(tx.QueryRow(ctx,
		`INSERT INTO petrichor_user
			(email, password_hash, system_role, user_type, username, nickname)
		 VALUES ($1, $2, 'SUPER_ADMIN', 'LOCAL', $3, $3)
		 RETURNING `+UserColumns,
		input.email, string(passwordHash), input.username))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		httpx.HandleError(c, err)
		return
	}

	setupCompleteCached.Store(true)
	token, err := loginWithSaToken(c, user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"token": token, "user": user.ToUserResponse()})
}
