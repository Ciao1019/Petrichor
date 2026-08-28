package auth

import (
	"strings"
	"testing"
)

func TestHashAgentAPIKey(t *testing.T) {
	// sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := HashAgentApiKey("abc"); got != want {
		t.Fatalf("sha256 不匹配: %s", got)
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
