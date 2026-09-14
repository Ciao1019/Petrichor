package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/httpx"
)

func TestLinuxDoBindingCallbackRestoresSessionUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(method, "/api/auth/callback", nil)
			ctx.Request.AddCookie(&http.Cookie{Name: linuxDoStateCookie, Value: "bind:test-state"})
			ctx.Request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "test-session"})
			user := &User{ID: 7}
			calls := 0
			mode, err := prepareLinuxDoCallback(ctx, "test-code", "bind:test-state", func(c *gin.Context) (*User, bool) {
				calls++
				if got := rawSessionTokenFromRequest(c); got != "test-session" {
					t.Fatalf("回调未使用浏览器登录 Cookie: %q", got)
				}
				return user, true
			})
			if err != nil || mode != "bind" {
				t.Fatalf("合法绑定回调被拒绝: mode=%q, err=%v", mode, err)
			}
			if calls != 1 || CurrentUser(ctx) != user {
				t.Fatal("绑定回调必须验证会话并把用户交给后续绑定逻辑")
			}
		})
	}
}

func TestLinuxDoLoginCallbackDoesNotRequireSession(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/auth/callback", nil)
	ctx.Request.AddCookie(&http.Cookie{Name: linuxDoStateCookie, Value: "login:test-state"})
	mode, err := prepareLinuxDoCallback(ctx, "test-code", "login:test-state", func(*gin.Context) (*User, bool) {
		t.Fatal("普通 LinuxDo 登录不应要求已有站内会话")
		return nil, false
	})
	if err != nil || mode != "login" || CurrentUser(ctx) != nil {
		t.Fatalf("未登录用户无法使用 LinuxDo 登录: mode=%q, err=%v", mode, err)
	}
}

func TestLinuxDoBindingCallbackRejectsInvalidSession(t *testing.T) {
	for _, test := range []struct {
		name string
		user *User
		ok   bool
	}{
		{name: "missing session"},
		{name: "revoked session", user: &User{ID: 7}},
		{name: "missing user", ok: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/auth/callback", nil)
			ctx.Request.AddCookie(&http.Cookie{Name: linuxDoStateCookie, Value: "bind:test-state"})
			_, err := prepareLinuxDoCallback(ctx, "test-code", "bind:test-state", func(*gin.Context) (*User, bool) {
				return test.user, test.ok
			})
			var httpErr *httpx.HttpError
			if !errors.As(err, &httpErr) || httpErr.Status != http.StatusUnauthorized {
				t.Fatalf("无有效登录会话时应拒绝绑定: %v", err)
			}
			if CurrentUser(ctx) != nil {
				t.Fatal("不能将无效会话的用户交给绑定逻辑")
			}
		})
	}
}

func TestLinuxDoCallbackValidatesStateBeforeSession(t *testing.T) {
	for _, test := range []struct {
		name   string
		code   string
		state  string
		cookie string
	}{
		{name: "missing code", state: "bind:test-state", cookie: "bind:test-state"},
		{name: "missing state cookie", code: "test-code", state: "bind:test-state"},
		{name: "mismatched state", code: "test-code", state: "bind:other-state", cookie: "bind:test-state"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/auth/callback", nil)
			if test.cookie != "" {
				ctx.Request.AddCookie(&http.Cookie{Name: linuxDoStateCookie, Value: test.cookie})
			}
			_, err := prepareLinuxDoCallback(ctx, test.code, test.state, func(*gin.Context) (*User, bool) {
				t.Fatal("无效回调不应读取登录会话")
				return nil, false
			})
			var httpErr *httpx.HttpError
			if !errors.As(err, &httpErr) || httpErr.Status != http.StatusBadRequest {
				t.Fatalf("无效授权码或状态应返回 400: %v", err)
			}
		})
	}
}
