package auth

import (
	"testing"
)

// 验证与 better-call signCookieValue 的互操作格式：
// encodeURIComponent(`${token}.${base64std(hmac_sha256(secret, token))}`)
func TestBetterAuthCookieRoundTrip(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	token := "pFBAUOhWyGvNqTcKsRmZxw==-abc123"

	signed := SignBetterAuthCookieValue(token, secret)
	if signed == "" {
		t.Fatal("签名为空")
	}

	got, ok := VerifyBetterAuthCookieValue(signed, secret)
	if !ok {
		t.Fatalf("验签失败: %s", signed)
	}
	if got != token {
		t.Fatalf("token 不匹配: got=%s want=%s", got, token)
	}
}

func TestVerifyBetterAuthCookieTampered(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	token := "test-session-token"
	signed := SignBetterAuthCookieValue(token, secret)

	// 篡改 token 部分
	idx := len(signed) - 1
	for i := len(signed) - 1; i >= 0; i-- {
		if signed[i] == '.' {
			idx = i
			break
		}
	}
	tampered := "evil" + signed[idx:]
	if _, ok := VerifyBetterAuthCookieValue(tampered, secret); ok {
		t.Fatal("篡改值不应通过验签")
	}
	// 错误密钥
	if _, ok := VerifyBetterAuthCookieValue(signed, "another-secret-another-secret!!"); ok {
		t.Fatal("错误密钥不应通过验签")
	}
	// 无签名
	if _, ok := VerifyBetterAuthCookieValue(token, secret); ok {
		t.Fatal("裸 token 不应通过验签")
	}
}

func TestHashSessionToken(t *testing.T) {
	// sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := HashSessionToken("abc"); got != want {
		t.Fatalf("sha256 不匹配: %s", got)
	}
}
