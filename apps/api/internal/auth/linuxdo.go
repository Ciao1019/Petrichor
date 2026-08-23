// LinuxDo OAuth：移植 linuxdo-handlers.ts / linuxdo-logic.ts。
// 登录仅允许已绑定且为超级管理员的用户；绑定分支要求已登录。
package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const (
	linuxDoAuthorizeURL  = "https://connect.linux.do/oauth2/authorize"
	linuxDoTokenURL      = "https://connect.linux.do/oauth2/token"
	linuxDoUserInfoURL   = "https://connect.linux.do/api/user"
	linuxDoStateCookie   = "petrichor_linuxdo_oauth_state"
	linuxDoFetchTimeout  = 30 * time.Second
	loginStatePrefix     = "login:"
	bindStatePrefix      = "bind:"
	dashboardRootPath    = "/dashboard"
	dashboardAccountPath = "/dashboard/account"
	stateCookieMaxAge    = 600
)

type linuxDoConfig struct {
	clientID     string
	clientSecret string
	redirectURI  string
}

func readEnvFallback(names ...string) string {
	for _, name := range names {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	return ""
}

// getLinuxDoConfig 环境变量缺失时返回禁用错误（文案与 TS 一致）。
func getLinuxDoConfig() (*linuxDoConfig, error) {
	clientID := readEnvFallback("PETRICHOR_LINUXDO_CLIENT_ID", "LINUXDO_CLIENT_ID")
	clientSecret := readEnvFallback("PETRICHOR_LINUXDO_CLIENT_SECRET", "LINUXDO_CLIENT_SECRET")
	redirectURI := readEnvFallback("PETRICHOR_LINUXDO_REDIRECT_URI", "LINUXDO_REDIRECT_URI")
	if redirectURI == "" {
		redirectURI = config.Get().BaseURL + "/api/auth/callback"
	}
	if clientID == "" || clientSecret == "" {
		return nil, httpx.BadRequest("LinuxDo 配置不完整")
	}
	return &linuxDoConfig{clientID: clientID, clientSecret: clientSecret, redirectURI: redirectURI}, nil
}

func setLinuxDoStateCookie(c *gin.Context, value string, maxAge int) {
	setSessionCookie(c, linuxDoStateCookie, value, maxAge)
}

func buildAuthorizeURL(cfg *linuxDoConfig, state string) string {
	params := url.Values{}
	params.Set("client_id", cfg.clientID)
	params.Set("redirect_uri", cfg.redirectURI)
	params.Set("response_type", "code")
	params.Set("state", state)
	return linuxDoAuthorizeURL + "?" + params.Encode()
}

// LinuxDoLoginStart GET /api/auth/linuxdo/login/start：302 跳转授权页并种 state cookie。
func LinuxDoLoginStart(c *gin.Context) {
	cfg, err := getLinuxDoConfig()
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	state := loginStatePrefix + randomBase64URL(24)
	setLinuxDoStateCookie(c, state, stateCookieMaxAge)
	c.Redirect(http.StatusFound, buildAuthorizeURL(cfg, state))
}

// LinuxDoBindStart GET /api/auth/linuxdo/bind/start：要求登录后发起绑定。
func LinuxDoBindStart(c *gin.Context) {
	if CurrentUser(c) == nil {
		httpx.ErrorJSON(c, http.StatusUnauthorized, "请先登录")
		return
	}
	cfg, err := getLinuxDoConfig()
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	state := bindStatePrefix + randomBase64URL(24)
	setLinuxDoStateCookie(c, state, stateCookieMaxAge)
	c.Redirect(http.StatusFound, buildAuthorizeURL(cfg, state))
}

type linuxDoCallbackRequest struct {
	Code  string `json:"code"`
	State string `json:"state"`
}

// LinuxDoCallbackPost POST /api/auth/linuxdo/callback：返回 JSON {mode, token, user}。
func LinuxDoCallbackPost(c *gin.Context) {
	var req linuxDoCallbackRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	result, err := handleLinuxDoCallback(c, strings.TrimSpace(req.Code), strings.TrimSpace(req.State))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if result.mode == "login" {
		setSessionCookie(c, SessionCookieName, result.token, int(config.Get().SessionExpire.Seconds()))
	}
	setLinuxDoStateCookie(c, "", 0)
	httpx.OK(c, gin.H{"mode": result.mode, "token": result.token, "user": result.user.ToUserResponse()})
}

// LinuxDoCallbackGet GET /api/auth/callback：302 回前端页面（login 带 token，bind 带成功标记）。
func LinuxDoCallbackGet(c *gin.Context) {
	code := c.Query("code")
	state := c.Query("state")
	result, err := handleLinuxDoCallback(c, strings.TrimSpace(code), strings.TrimSpace(state))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	base := config.Get().BaseURL
	target := base + dashboardRootPath + "?token=" + url.QueryEscape(result.token)
	if result.mode == "bind" {
		target = base + dashboardAccountPath + "?linuxdoBinding=success"
	}
	if result.mode == "login" {
		setSessionCookie(c, SessionCookieName, result.token, int(config.Get().SessionExpire.Seconds()))
	}
	setLinuxDoStateCookie(c, "", 0)
	c.Redirect(http.StatusFound, target)
}

type linuxDoCallbackResult struct {
	mode  string
	token string
	user  *User
}

// handleLinuxDoCallback 校验 code/state → 换 token → 拉取用户信息 → 分发登录或绑定。
func handleLinuxDoCallback(c *gin.Context, code, state string) (*linuxDoCallbackResult, error) {
	if code == "" {
		return nil, httpx.BadRequest("授权码不能为空")
	}
	mode, err := resolveLinuxDoCallbackMode(c, state)
	if err != nil {
		return nil, err
	}
	cfg, err := getLinuxDoConfig()
	if err != nil {
		return nil, err
	}

	accessToken, err := fetchLinuxDoAccessToken(code, cfg)
	if err != nil {
		return nil, err
	}
	rawUserInfo, err := fetchLinuxDoUserInfo(accessToken)
	if err != nil {
		return nil, err
	}
	userInfo := normalizeLinuxDoUserInfo(rawUserInfo)

	if mode == "bind" {
		user, berr := bindLinuxDoAccount(c, userInfo)
		if berr != nil {
			return nil, berr
		}
		return &linuxDoCallbackResult{mode: "bind", token: "", user: user}, nil
	}

	user, token, lerr := resolveLinuxDoLoginUser(userInfo, requestIP(c), c.Request.UserAgent())
	if lerr != nil {
		return nil, lerr
	}
	return &linuxDoCallbackResult{mode: "login", token: token, user: user}, nil
}

// resolveLinuxDoCallbackMode 复刻 TS 的 state 校验分支。
func resolveLinuxDoCallbackMode(c *gin.Context, state string) (string, error) {
	storedState, _ := c.Cookie(linuxDoStateCookie)
	hasStored := storedState != ""

	if state == "" {
		return "login", nil
	}
	if !hasStored && strings.HasPrefix(state, bindStatePrefix) {
		return "", httpx.BadRequest("绑定状态已失效，请重新发起绑定")
	}
	if !hasStored {
		return "login", nil
	}
	if state != storedState {
		return "", httpx.BadRequest("授权状态校验失败，请重新发起操作")
	}
	if strings.HasPrefix(storedState, bindStatePrefix) {
		return "bind", nil
	}
	return "login", nil
}

func findPetrichorUserByLinuxDoAccountID(accountID string) (*User, error) {
	row := db.Pool().QueryRow(ctx(),
		`SELECT `+UserColumns+` FROM petrichor_user WHERE linuxdo_account_id = $1 LIMIT 1`, accountID)
	u, err := ScanUser(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

const linuxDoUserUpdateSetClause = `linuxdo_account_id = $1, linuxdo_email = $2, linuxdo_username = $3,
	username = COALESCE(NULLIF(username, ''), $4), nickname = COALESCE(NULLIF(nickname, ''), $5),
	avatar = COALESCE(NULLIF(avatar, ''), $6), updated_at = now()`

func updateLinuxDoBoundUser(userID int64, userInfo *normalizedLinuxDoUser) (*User, error) {
	return ScanUser(db.Pool().QueryRow(ctx(),
		`UPDATE petrichor_user SET `+linuxDoUserUpdateSetClause+` WHERE id = $4 RETURNING `+UserColumns,
		userInfo.accountID, userInfo.email, userInfo.username,
		userInfo.username, userInfo.nickname, userInfo.avatar, userID))
}

// resolveLinuxDoLoginUser 仅允许绑定到超级管理员的 Linux.do 账号登录后台，
// 成功后创建自建会话并签发裸 token。
func resolveLinuxDoLoginUser(userInfo *normalizedLinuxDoUser, ip, userAgent string) (*User, string, error) {
	boundUser, err := findPetrichorUserByLinuxDoAccountID(userInfo.accountID)
	if err != nil {
		return nil, "", err
	}
	if boundUser == nil {
		return nil, "", httpx.Unauthorized("该 Linux.do 账号未绑定超级管理员，无法登录后台")
	}
	if !boundUser.IsSuperAdmin() {
		return nil, "", httpx.Unauthorized("该 Linux.do 账号绑定的用户不是超级管理员，无法登录后台")
	}

	u, uerr := updateLinuxDoBoundUser(boundUser.ID, userInfo)
	if uerr != nil {
		return nil, "", uerr
	}
	token, terr := issuePetrichorSession(u.ID, ip, userAgent)
	if terr != nil {
		return nil, "", terr
	}
	return u, token, nil
}

// bindLinuxDoAccount 绑定当前登录用户（冲突检测与 TS 一致）。
func bindLinuxDoAccount(c *gin.Context, userInfo *normalizedLinuxDoUser) (*User, error) {
	current := CurrentUser(c)
	if current == nil {
		return nil, httpx.Unauthorized("请先登录")
	}
	if deref(current.LinuxDoAccountID) != "" && deref(current.LinuxDoAccountID) != userInfo.accountID {
		return nil, httpx.BadRequest("当前账号已绑定其他 Linux.do 账号")
	}
	existing, err := findPetrichorUserByLinuxDoAccountID(userInfo.accountID)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.ID != current.ID {
		return nil, httpx.BadRequest("该 Linux.do 账号已绑定其他用户")
	}
	return updateLinuxDoBoundUser(current.ID, userInfo)
}

// ---- 上游 HTTP 调用（带一次重试与 30s 超时） ----

func linuxDoFetch(rawURL string, buildReq func() (*http.Request, error)) (*http.Response, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := buildReq()
		if err != nil {
			lastErr = err
			continue
		}
		client := &http.Client{Timeout: linuxDoFetchTimeout}
		resp, err := client.Do(req)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if attempt == 0 {
			time.Sleep(180 * time.Millisecond)
		}
	}
	if lastErr == nil {
		return nil, httpx.BadRequest("LinuxDo 请求失败")
	}
	if errors.Is(lastErr, context.DeadlineExceeded) || strings.Contains(lastErr.Error(), "Client.Timeout") {
		return nil, httpx.BadRequest("LinuxDo 请求超时，请稍后重试")
	}
	return nil, httpx.BadRequest(lastErr.Error())
}

func fetchLinuxDoAccessToken(code string, cfg *linuxDoConfig) (string, error) {
	form := url.Values{}
	form.Set("code", code)
	form.Set("redirect_uri", cfg.redirectURI)
	form.Set("grant_type", "authorization_code")
	basicAuth := base64.StdEncoding.EncodeToString([]byte(cfg.clientID + ":" + cfg.clientSecret))

	resp, err := linuxDoFetch(linuxDoTokenURL, func() (*http.Request, error) {
		req, rerr := http.NewRequest(http.MethodPost, linuxDoTokenURL, strings.NewReader(form.Encode()))
		if rerr != nil {
			return nil, rerr
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Basic "+basicAuth)
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return req, nil
	})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	bodyText := string(body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Error("LinuxDo token exchange failed",
			"status", resp.StatusCode, "redirectUri", cfg.redirectURI,
			"body", truncateForLog(bodyText))
		return "", httpx.BadRequest(resolveLinuxDoTokenErrorMessage(resp.StatusCode, bodyText))
	}

	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if jerr := json.Unmarshal(body, &payload); jerr != nil || strings.TrimSpace(payload.AccessToken) == "" {
		return "", httpx.BadRequest("获取访问令牌失败")
	}
	return payload.AccessToken, nil
}

func truncateForLog(s string) string {
	runes := []rune(s)
	if len(runes) > 800 {
		return string(runes[:800])
	}
	return s
}

func resolveLinuxDoTokenErrorMessage(status int, body string) string {
	errorCode := parseLinuxDoErrorCode(body)
	switch {
	case errorCode == "invalid_client" || status == http.StatusUnauthorized:
		return "LinuxDo Client ID 或 Client Secret 配置错误"
	case errorCode == "invalid_grant":
		return "LinuxDo 授权码已失效或回调地址不匹配，请重新从登录页发起登录"
	case errorCode == "invalid_request":
		return "LinuxDo 授权请求参数错误，请检查回调地址配置"
	default:
		return "获取访问令牌失败"
	}
}

func parseLinuxDoErrorCode(body string) string {
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return ""
	}
	return payload.Error
}

func fetchLinuxDoUserInfo(accessToken string) (map[string]any, error) {
	resp, err := linuxDoFetch(linuxDoUserInfoURL, func() (*http.Request, error) {
		req, rerr := http.NewRequest(http.MethodGet, linuxDoUserInfoURL, nil)
		if rerr != nil {
			return nil, rerr
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)
		return req, nil
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, httpx.BadRequest("获取用户信息失败")
	}
	var raw map[string]any
	if jerr := json.Unmarshal(body, &raw); jerr != nil {
		return nil, httpx.BadRequest("获取用户信息失败")
	}
	return raw, nil
}

// ---- 用户信息归一化（linuxdo-logic.ts） ----

type normalizedLinuxDoUser struct {
	accountID string
	email     string
	username  *string
	nickname  *string
	avatar    *string
}

func readLinuxDoString(raw map[string]any, key string) *string {
	switch v := raw[key].(type) {
	case string:
		return &v
	case float64:
		s := strconv.FormatFloat(v, 'f', -1, 64)
		return &s
	default:
		return nil
	}
}

func normalizeLinuxDoUserInfo(raw map[string]any) *normalizedLinuxDoUser {
	username := readLinuxDoString(raw, "username")
	accountIDRaw := firstNonEmpty(deref(readLinuxDoString(raw, "id")),
		deref(readLinuxDoString(raw, "user_id")), deref(readLinuxDoString(raw, "sub")))
	email := strings.TrimSpace(deref(readLinuxDoString(raw, "email")))
	if email == "" {
		if username != nil && *username != "" {
			email = *username + "@linux.do"
		} else {
			email = "null@linux.do"
		}
	}
	nickname := readLinuxDoString(raw, "name")
	if nickname == nil || strings.TrimSpace(*nickname) == "" {
		nickname = username
	}

	return &normalizedLinuxDoUser{
		accountID: strings.ToLower(firstNonEmpty(accountIDRaw, deref(username), email)),
		email:     email,
		username:  username,
		nickname:  nickname,
		avatar:    readLinuxDoString(raw, "avatar_url"),
	}
}
