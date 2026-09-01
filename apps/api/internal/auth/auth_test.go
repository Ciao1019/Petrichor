package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestHashAgentAPIKey(t *testing.T) {
	// sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := HashAgentApiKey("abc"); got != want {
		t.Fatalf("sha256 不匹配: %s", got)
	}
}

func TestRawSessionTokenFromRequestNeverReadsQuery(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name    string
		headers map[string]string
		cookie  *http.Cookie
		query   string
		want    string
	}{
		{name: "authorization", headers: map[string]string{"Authorization": "Bearer header-token"}, want: "header-token"},
		{name: "named header wins", headers: map[string]string{SessionCookieName: "named-token", "Authorization": "Bearer bearer-token"}, want: "named-token"},
		{name: "cookie", cookie: &http.Cookie{Name: SessionCookieName, Value: "cookie-token"}, want: "cookie-token"},
		{name: "query rejected", query: SessionCookieName + "=leaked-token", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			request := httptest.NewRequest(http.MethodGet, "/api/me?"+tt.query, nil)
			for name, value := range tt.headers {
				request.Header.Set(name, value)
			}
			if tt.cookie != nil {
				request.AddCookie(tt.cookie)
			}
			ctx.Request = request
			if got := rawSessionTokenFromRequest(ctx); got != tt.want {
				t.Fatalf("token = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRequestIPOnlyTrustsConfiguredProxy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name          string
		trusted       []string
		remoteAddress string
		forwardedFor  string
		want          string
	}{
		{name: "untrusted cannot spoof", trusted: []string{"127.0.0.1/32"}, remoteAddress: "203.0.113.10:4321", forwardedFor: "1.2.3.4", want: "203.0.113.10"},
		{name: "trusted proxy accepted", trusted: []string{"127.0.0.1/32"}, remoteAddress: "127.0.0.1:4321", forwardedFor: "198.51.100.8", want: "198.51.100.8"},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := gin.New()
			if err := engine.SetTrustedProxies(test.trusted); err != nil {
				t.Fatal(err)
			}
			engine.GET("/", func(c *gin.Context) { c.String(http.StatusOK, requestIP(c)) })
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.RemoteAddr = test.remoteAddress
			request.Header.Set("X-Forwarded-For", test.forwardedFor)
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, request)
			if got := recorder.Body.String(); got != test.want {
				t.Fatalf("requestIP = %q, want %q", got, test.want)
			}
		})
	}
}

func TestNormalizeSetupRequest(t *testing.T) {
	input, err := normalizeSetupRequest(setupRequest{
		Email:    "  OWNER@Example.com ",
		Username: "  站长  ",
		Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("合法初始化参数被拒绝: %v", err)
	}
	if input.email != "owner@example.com" {
		t.Fatalf("邮箱未规范化: %q", input.email)
	}
	if input.username != "站长" {
		t.Fatalf("管理员名称未去除空格: %q", input.username)
	}
}

func TestNormalizeSetupRequestRejectsWeakInput(t *testing.T) {
	tests := []struct {
		name string
		req  setupRequest
		msg  string
	}{
		{
			name: "invalid email",
			req:  setupRequest{Email: "owner", Username: "站长", Password: "12345678"},
			msg:  "邮箱格式不正确",
		},
		{
			name: "short username",
			req:  setupRequest{Email: "owner@example.com", Username: "x", Password: "12345678"},
			msg:  "管理员名称长度",
		},
		{
			name: "short password",
			req:  setupRequest{Email: "owner@example.com", Username: "站长", Password: "1234567"},
			msg:  "密码长度至少为 8 位",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := normalizeSetupRequest(tt.req)
			if err == nil || !strings.Contains(err.Error(), tt.msg) {
				t.Fatalf("期望错误包含 %q，实际为 %v", tt.msg, err)
			}
		})
	}
}
