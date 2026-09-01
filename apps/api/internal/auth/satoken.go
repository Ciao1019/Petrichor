package auth

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	sagin "github.com/sa-tokens/sa-token-go/integrations/gin"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/satokenstore"
)

const (
	SessionCookieName       = "petrichor_session"
	saTokenDeviceInfoKey    = "deviceInfo"
	saTokenIPKey            = "ip"
	saTokenUserAgentKey     = "userAgent"
	saTokenStorageKeyPrefix = "petrichor"
)

var (
	saTokenManager *sagin.Manager
	saTokenPlugin  *sagin.Plugin
	saTokenMu      sync.RWMutex
)

// InitializeSaToken 在数据库迁移完成后初始化 Sa-Token。
func InitializeSaToken() error {
	storage := satokenstore.New(db.Pool())
	if err := storage.Ping(); err != nil {
		return fmt.Errorf("初始化 Sa-Token PostgreSQL 存储失败: %w", err)
	}

	cfg := config.Get()
	manager, err := sagin.NewBuilder().
		Storage(storage).
		TokenName(SessionCookieName).
		TimeoutDuration(cfg.SessionExpire).
		RenewInterval(60).
		IsConcurrent(true).
		IsShare(false).
		MaxLoginCount(12).
		TokenStyle(sagin.TokenStyleRandom64).
		AutoRenew(true).
		IsReadBody(false).
		IsReadHeader(true).
		IsReadCookie(true).
		CookiePath("/").
		CookieSecure(config.IsProduction()).
		CookieHttpOnly(true).
		CookieSameSite("Lax").
		KeyPrefix(saTokenStorageKeyPrefix).
		IsPrintBanner(false).
		TryBuild()
	if err != nil {
		return fmt.Errorf("初始化 Sa-Token 失败: %w", err)
	}

	saTokenMu.Lock()
	saTokenManager = manager
	saTokenPlugin = sagin.NewPlugin(manager)
	saTokenMu.Unlock()
	sagin.SetManager(manager)
	return nil
}

func managerAndPlugin() (*sagin.Manager, *sagin.Plugin) {
	saTokenMu.RLock()
	defer saTokenMu.RUnlock()
	if saTokenManager == nil || saTokenPlugin == nil {
		panic("Sa-Token 尚未初始化")
	}
	return saTokenManager, saTokenPlugin
}

// SaTokenInterceptor 使用官方 Gin 集成统一提取 Header、Cookie 和 Query token。
func SaTokenInterceptor() gin.HandlerFunc {
	manager, _ := managerAndPlugin()
	return func(c *gin.Context) {
		// 上游 Sa-Token 默认还会从 Query 读取 Token。Session 出现在 URL 中会泄漏到
		// 访问日志、浏览器历史和 Referrer，因此这里只允许 Header/Cookie。
		c.Set("satoken_token", manager.CutTokenPrefix(rawSessionTokenFromRequest(c)))
		c.Next()
	}
}

func rawSessionTokenFromRequest(c *gin.Context) string {
	if value := strings.TrimSpace(c.GetHeader(SessionCookieName)); value != "" {
		return value
	}
	if authorization := strings.TrimSpace(c.GetHeader("Authorization")); authorization != "" {
		const bearer = "Bearer "
		if len(authorization) > len(bearer) && strings.EqualFold(authorization[:len(bearer)], bearer) {
			return strings.TrimSpace(authorization[len(bearer):])
		}
	}
	if cookie, err := c.Cookie(SessionCookieName); err == nil {
		return strings.TrimSpace(cookie)
	}
	return ""
}

func currentSaToken(c *gin.Context) string {
	if token := sagin.GetTokenFromCtx(c); token != "" {
		return token
	}
	manager, _ := managerAndPlugin()
	return manager.CutTokenPrefix(rawSessionTokenFromRequest(c))
}

func setAuthTokenCookie(c *gin.Context, token string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(config.Get().SessionExpire.Seconds()),
		HttpOnly: true,
		Secure:   config.IsProduction(),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearAuthTokenCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   config.IsProduction(),
		SameSite: http.SameSiteLaxMode,
	})
}

func issueSaTokenSession(userID int64, ip, userAgent string) (string, error) {
	manager, _ := managerAndPlugin()
	deviceID := randomBase64URL(18)
	token, err := manager.Login(strconv.FormatInt(userID, 10), deviceID)
	if err != nil {
		return "", err
	}

	tokenSession, err := manager.GetTokenSession(token, true)
	if err == nil && tokenSession != nil {
		err = tokenSession.SetMulti(map[string]any{
			saTokenDeviceInfoKey: "web",
			saTokenIPKey:         ip,
			saTokenUserAgentKey:  userAgent,
		}, config.Get().SessionExpire)
	}
	if err != nil {
		_ = manager.LogoutByToken(token)
		return "", err
	}
	return token, nil
}

func loginWithSaToken(c *gin.Context, userID int64) (string, error) {
	token, err := issueSaTokenSession(userID, requestIP(c), c.Request.UserAgent())
	if err != nil {
		return "", err
	}
	setAuthTokenCookie(c, token)
	return token, nil
}

// LogoutSaTokenUser 注销指定用户的所有登录，供用户删除等后台操作使用。
func LogoutSaTokenUser(userID int64) error {
	manager, _ := managerAndPlugin()
	return manager.Logout(strconv.FormatInt(userID, 10))
}

func logoutOtherSaTokenSessions(userID int64, currentToken string) (int64, error) {
	manager, _ := managerAndPlugin()
	tokens, err := manager.GetTokenValueListByLoginID(strconv.FormatInt(userID, 10))
	if err != nil {
		return 0, err
	}
	var revoked int64
	for _, token := range tokens {
		if token == "" || token == currentToken {
			continue
		}
		if err := manager.LogoutByToken(token); err != nil {
			return revoked, err
		}
		revoked++
	}
	return revoked, nil
}

func renewSaTokenActivity(token string) {
	if token == "" {
		return
	}
	manager, _ := managerAndPlugin()
	_ = manager.UpdateLastActiveToNow(token)
	if tokenSession, err := manager.GetTokenSession(token, false); err == nil && tokenSession != nil {
		_ = tokenSession.Renew(config.Get().SessionExpire)
	}
}

func saTokenExpiry(token string) time.Time {
	manager, _ := managerAndPlugin()
	ttlSeconds, err := manager.GetTokenTimeout(token)
	if err != nil || ttlSeconds < 0 {
		return time.Time{}
	}
	return time.Now().Add(time.Duration(ttlSeconds) * time.Second)
}
