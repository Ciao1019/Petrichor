package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/user"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	linuxDoAuthorizeURL     = "https://connect.linux.do/oauth2/authorize"
	linuxDoTokenURL         = "https://connect.linux.do/oauth2/token"
	linuxDoUserInfoURL      = "https://connect.linux.do/api/user"
	linuxDoOauthStateCookie = "petrichor_linuxdo_oauth_state"
	linuxDoStateMaxAge      = 600
	linuxDoLoginStatePrefix = "login:"
	linuxDoBindStatePrefix  = "bind:"
)

type linuxDoUserInfo struct {
	AccountID string
	Email     string
	Username  *string
	Nickname  *string
	Avatar    *string
}

func (h *Handler) linuxDoRedirectURI() string {
	if strings.TrimSpace(h.cfg.LinuxDo.RedirectURI) != "" {
		return strings.TrimSpace(h.cfg.LinuxDo.RedirectURI)
	}
	return h.linuxDoFrontendURL("/api/auth/callback").String()
}

func (h *Handler) linuxDoFrontendURL(path string) *url.URL {
	target, err := url.Parse(strings.TrimSpace(h.cfg.AppURL))
	if err != nil || target.Scheme == "" || target.Host == "" {
		return &url.URL{Path: path}
	}
	target.Path = path
	target.RawPath = ""
	target.RawQuery = ""
	target.Fragment = ""
	return target
}

func (h *Handler) requireLinuxDoConfig() (clientID, clientSecret, redirectURI string, err error) {
	clientID = strings.TrimSpace(h.cfg.LinuxDo.ClientID)
	clientSecret = strings.TrimSpace(h.cfg.LinuxDo.ClientSecret)
	redirectURI = h.linuxDoRedirectURI()
	if clientID == "" || clientSecret == "" {
		return "", "", "", response.BadRequest("LinuxDo 配置不完整")
	}
	return clientID, clientSecret, redirectURI, nil
}

func randomLinuxDoState(prefix string) (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

func (h *Handler) setLinuxDoStateCookie(c *gin.Context, state string) {
	secure := h.cfg.IsProduction()
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(linuxDoOauthStateCookie, state, linuxDoStateMaxAge, "/", "", secure, true)
}

func (h *Handler) clearLinuxDoStateCookie(c *gin.Context) {
	secure := h.cfg.IsProduction()
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(linuxDoOauthStateCookie, "", -1, "/", "", secure, true)
}

func (h *Handler) buildLinuxDoAuthorizeURL(clientID, redirectURI, state string) string {
	q := url.Values{}
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	q.Set("state", state)
	return linuxDoAuthorizeURL + "?" + q.Encode()
}

// LinuxDoLoginStart GET：跳转 connect.linux.do，写入 login 状态 Cookie。
func (h *Handler) LinuxDoLoginStart(c *gin.Context) {
	clientID, _, redirectURI, err := h.requireLinuxDoConfig()
	if err != nil {
		response.Fail(c, err)
		return
	}
	state, err := randomLinuxDoState(linuxDoLoginStatePrefix)
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setLinuxDoStateCookie(c, state)
	c.Redirect(http.StatusFound, h.buildLinuxDoAuthorizeURL(clientID, redirectURI, state))
}

// LinuxDoBindStart GET：需登录，写入 bind 状态 Cookie 并跳转。
func (h *Handler) LinuxDoBindStart(c *gin.Context) {
	token := ExtractToken(c, h.cfg.SessionCookieName)
	u, _, err := h.svc.CurrentUser(c.Request.Context(), token)
	if err != nil {
		response.Fail(c, err)
		return
	}
	c.Set(contextUserKey, u)

	clientID, _, redirectURI, err := h.requireLinuxDoConfig()
	if err != nil {
		response.Fail(c, err)
		return
	}
	state, err := randomLinuxDoState(linuxDoBindStatePrefix)
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.setLinuxDoStateCookie(c, state)
	c.Redirect(http.StatusFound, h.buildLinuxDoAuthorizeURL(clientID, redirectURI, state))
}

// LinuxDoCallbackGet GET：处理 code/state，重定向到 AppURL。
func (h *Handler) LinuxDoCallbackGet(c *gin.Context) {
	code := strings.TrimSpace(c.Query("code"))
	state := strings.TrimSpace(c.Query("state"))
	result, err := h.handleLinuxDoCallback(c, code, state)
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.clearLinuxDoStateCookie(c)
	targetPath := "/dashboard"
	if result.Mode == "bind" {
		targetPath = "/dashboard/account"
	}
	target := h.linuxDoFrontendURL(targetPath)
	q := target.Query()
	if result.Mode == "bind" {
		q.Set("linuxdoBinding", "success")
	} else {
		q.Set("token", result.Token)
		h.setSessionCookie(c, result.Token)
	}
	target.RawQuery = q.Encode()
	c.Redirect(http.StatusFound, target.String())
}

// LinuxDoCallbackPost POST：{code, state?} JSON 响应。
func (h *Handler) LinuxDoCallbackPost(c *gin.Context) {
	var req struct {
		Code  string  `json:"code"`
		State *string `json:"state"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	state := ""
	if req.State != nil {
		state = strings.TrimSpace(*req.State)
	}
	result, err := h.handleLinuxDoCallback(c, strings.TrimSpace(req.Code), state)
	if err != nil {
		response.Fail(c, err)
		return
	}
	h.clearLinuxDoStateCookie(c)
	if result.Mode == "login" {
		h.setSessionCookie(c, result.Token)
	}
	response.OK(c, gin.H{
		"mode":  result.Mode,
		"token": result.Token,
		"user":  ToUserDTO(result.User),
	})
}

type linuxDoCallbackResult struct {
	Mode  string
	Token string
	User  *ent.User
}

func (h *Handler) handleLinuxDoCallback(c *gin.Context, code, state string) (*linuxDoCallbackResult, error) {
	if strings.TrimSpace(code) == "" {
		return nil, response.BadRequest("授权码不能为空")
	}
	mode, err := h.resolveLinuxDoCallbackMode(c, state)
	if err != nil {
		return nil, err
	}
	clientID, clientSecret, redirectURI, err := h.requireLinuxDoConfig()
	if err != nil {
		return nil, err
	}
	accessToken, err := exchangeLinuxDoToken(c, code, clientID, clientSecret, redirectURI)
	if err != nil {
		return nil, err
	}
	info, err := fetchLinuxDoUser(c, accessToken)
	if err != nil {
		return nil, err
	}
	if mode == "bind" {
		u, err := h.bindLinuxDoAccount(c, info)
		if err != nil {
			return nil, err
		}
		return &linuxDoCallbackResult{Mode: "bind", Token: "", User: u}, nil
	}
	u, err := h.resolveLinuxDoLoginUser(c, info)
	if err != nil {
		return nil, err
	}
	token, _, err := h.svc.CreateSession(c.Request.Context(), u.ID, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		return nil, err
	}
	return &linuxDoCallbackResult{Mode: "login", Token: token, User: u}, nil
}

func (h *Handler) resolveLinuxDoCallbackMode(c *gin.Context, state string) (string, error) {
	stored, _ := c.Cookie(linuxDoOauthStateCookie)
	stored = strings.TrimSpace(stored)
	state = strings.TrimSpace(state)
	if state == "" {
		return "login", nil
	}
	if stored == "" && strings.HasPrefix(state, linuxDoBindStatePrefix) {
		return "", response.BadRequest("绑定状态已失效，请重新发起绑定")
	}
	if stored == "" {
		return "login", nil
	}
	if state != stored {
		return "", response.BadRequest("授权状态校验失败，请重新发起操作")
	}
	if strings.HasPrefix(stored, linuxDoBindStatePrefix) {
		return "bind", nil
	}
	return "login", nil
}

func (h *Handler) resolveLinuxDoLoginUser(c *gin.Context, info linuxDoUserInfo) (*ent.User, error) {
	u, err := h.svc.client.User.Query().
		Where(user.LinuxDoAccountIDEQ(info.AccountID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.Unauthorized("该 Linux.do 账号未绑定超级管理员，无法登录后台")
		}
		return nil, err
	}
	if !IsSuperAdmin(u) {
		return nil, response.Unauthorized("该 Linux.do 账号绑定的用户不是超级管理员，无法登录后台")
	}
	return h.applyLinuxDoUserFields(c, u, info)
}

func (h *Handler) bindLinuxDoAccount(c *gin.Context, info linuxDoUserInfo) (*ent.User, error) {
	token := ExtractToken(c, h.cfg.SessionCookieName)
	current, _, err := h.svc.CurrentUser(c.Request.Context(), token)
	if err != nil {
		return nil, err
	}
	if current.LinuxDoAccountID != nil && strings.TrimSpace(*current.LinuxDoAccountID) != "" &&
		strings.TrimSpace(*current.LinuxDoAccountID) != info.AccountID {
		return nil, response.BadRequest("当前账号已绑定其他 Linux.do 账号")
	}
	existing, err := h.svc.client.User.Query().
		Where(user.LinuxDoAccountIDEQ(info.AccountID)).
		Only(c.Request.Context())
	if err == nil && existing.ID != current.ID {
		return nil, response.BadRequest("该 Linux.do 账号已绑定其他用户")
	}
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	return h.applyLinuxDoUserFields(c, current, info)
}

func (h *Handler) applyLinuxDoUserFields(c *gin.Context, u *ent.User, info linuxDoUserInfo) (*ent.User, error) {
	upd := h.svc.client.User.UpdateOneID(u.ID).
		SetLinuxDoAccountID(info.AccountID).
		SetLinuxDoEmail(info.Email)
	if info.Username != nil {
		upd.SetLinuxDoUsername(*info.Username)
		if u.Username == nil || strings.TrimSpace(*u.Username) == "" {
			upd.SetUsername(*info.Username)
		}
	}
	if info.Nickname != nil && (u.Nickname == nil || strings.TrimSpace(*u.Nickname) == "") {
		upd.SetNickname(*info.Nickname)
	}
	if info.Avatar != nil && (u.Avatar == nil || strings.TrimSpace(*u.Avatar) == "") {
		upd.SetAvatar(*info.Avatar)
	}
	return upd.Save(c.Request.Context())
}

func exchangeLinuxDoToken(c *gin.Context, code, clientID, clientSecret, redirectURI string) (string, error) {
	form := url.Values{}
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("grant_type", "authorization_code")
	basic := base64.StdEncoding.EncodeToString([]byte(clientID + ":" + clientSecret))
	headers := make(http.Header)
	headers.Set("Authorization", "Basic "+basic)
	headers.Set("Content-Type", "application/x-www-form-urlencoded")
	headers.Set("Accept", "application/json")
	resp, err := doLinuxDoRequest(c.Request.Context(), http.MethodPost, linuxDoTokenURL, []byte(form.Encode()), headers)
	if err != nil {
		return "", response.BadRequest("LinuxDo 请求失败")
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 {
		return "", response.BadRequest(resolveLinuxDoTokenError(resp.StatusCode, string(raw)))
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || strings.TrimSpace(payload.AccessToken) == "" {
		return "", response.BadRequest("获取访问令牌失败")
	}
	return payload.AccessToken, nil
}

func resolveLinuxDoTokenError(status int, body string) string {
	var payload struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal([]byte(body), &payload)
	switch {
	case payload.Error == "invalid_client" || status == 401:
		return "LinuxDo Client ID 或 Client Secret 配置错误"
	case payload.Error == "invalid_grant":
		return "LinuxDo 授权码已失效或回调地址不匹配，请重新从登录页发起登录"
	case payload.Error == "invalid_request":
		return "LinuxDo 授权请求参数错误，请检查回调地址配置"
	default:
		return "获取访问令牌失败"
	}
}

func fetchLinuxDoUser(c *gin.Context, accessToken string) (linuxDoUserInfo, error) {
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+accessToken)
	resp, err := doLinuxDoRequest(c.Request.Context(), http.MethodGet, linuxDoUserInfoURL, nil, headers)
	if err != nil {
		return linuxDoUserInfo{}, response.BadRequest("获取用户信息失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return linuxDoUserInfo{}, response.BadRequest("获取用户信息失败")
	}
	var raw map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return linuxDoUserInfo{}, response.BadRequest("获取用户信息失败")
	}
	return normalizeLinuxDoUserInfo(raw), nil
}

// doLinuxDoRequest 恢复旧实现的一次短间隔重试；仅网络异常重试，HTTP 错误直接交给调用方处理。
func doLinuxDoRequest(ctx context.Context, method, target string, body []byte, headers http.Header) (*http.Response, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header = headers.Clone()
		resp, err := client.Do(req)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if attempt == 0 {
			timer := time.NewTimer(180 * time.Millisecond)
			select {
			case <-timer.C:
			case <-ctx.Done():
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				return nil, ctx.Err()
			}
		}
	}
	var networkErr net.Error
	if errors.Is(lastErr, context.DeadlineExceeded) || (errors.As(lastErr, &networkErr) && networkErr.Timeout()) {
		return nil, response.BadRequest("LinuxDo 请求超时，请稍后重试")
	}
	return nil, response.BadRequest("LinuxDo 请求失败")
}

func normalizeLinuxDoUserInfo(raw map[string]any) linuxDoUserInfo {
	username := readLinuxDoString(raw, "username")
	accountID := readLinuxDoString(raw, "id")
	if accountID == nil {
		accountID = readLinuxDoString(raw, "user_id")
	}
	if accountID == nil {
		accountID = readLinuxDoString(raw, "sub")
	}
	email := readLinuxDoString(raw, "email")
	if email == nil || strings.TrimSpace(*email) == "" {
		if username != nil {
			v := *username + "@linux.do"
			email = &v
		} else {
			v := "null@linux.do"
			email = &v
		}
	}
	nickname := readLinuxDoString(raw, "name")
	if nickname == nil || strings.TrimSpace(*nickname) == "" {
		nickname = username
	}
	account := ""
	if accountID != nil && strings.TrimSpace(*accountID) != "" {
		account = strings.ToLower(strings.TrimSpace(*accountID))
	} else if username != nil {
		account = strings.ToLower(strings.TrimSpace(*username))
	} else {
		account = strings.ToLower(strings.TrimSpace(*email))
	}
	return linuxDoUserInfo{
		AccountID: account,
		Email:     *email,
		Username:  username,
		Nickname:  nickname,
		Avatar:    readLinuxDoString(raw, "avatar_url"),
	}
}

func readLinuxDoString(raw map[string]any, key string) *string {
	v, ok := raw[key]
	if !ok || v == nil {
		return nil
	}
	switch t := v.(type) {
	case string:
		s := t
		return &s
	case float64:
		if t != t || t > 1.7976931348623157e+308 || t < -1.7976931348623157e+308 {
			return nil
		}
		s := strconv.FormatFloat(t, 'f', -1, 64)
		return &s
	case json.Number:
		s := t.String()
		return &s
	default:
		return nil
	}
}
