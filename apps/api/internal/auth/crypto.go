package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/url"
	"strings"
)

// BetterAuthCookieName 复刻 session.ts 的 getBetterAuthSessionCookieName。
func BetterAuthCookieName(production bool) string {
	if production {
		return "__Secure-petrichor.session_token"
	}
	return "petrichor.session_token"
}

const (
	SessionCookieName      = "petrichor_session" // 自建会话 cookie
	betterAuthCookiePrefix = "petrichor"
)

// SignBetterAuthCookieValue 计算 better-auth 签名 cookie 值：
// encodeURIComponent(`${token}.${base64_std(hmac_sha256(secret, token))}`)。
// 与 better-call dist/crypto.mjs 的 signCookieValue 一致。
func SignBetterAuthCookieValue(token, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(token))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return url.QueryEscape(token + "." + sig)
}

// VerifyBetterAuthCookieValue 校验签名并返回裸 token。
func VerifyBetterAuthCookieValue(raw, secret string) (string, bool) {
	if raw == "" {
		return "", false
	}
	decoded, err := url.QueryUnescape(raw)
	if err != nil {
		decoded = raw
	}
	idx := strings.LastIndex(decoded, ".")
	if idx < 1 {
		return "", false
	}
	token := decoded[:idx]
	sig := decoded[idx+1:]
	sigBytes, err := base64.StdEncoding.DecodeString(sig)
	if err != nil || len(sigBytes) != 32 {
		return "", false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(token))
	expected := mac.Sum(nil)
	if !hmac.Equal(sigBytes, expected) {
		return "", false
	}
	return token, true
}

// HashSessionToken 复刻 session.ts：sha256 hex。
func HashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// HashAgentApiKey 复刻 agent/api-key.ts：sha256 hex（utf8）。
func HashAgentApiKey(apiKey string) string {
	return HashSessionToken(apiKey)
}
