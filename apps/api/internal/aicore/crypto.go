// Package aicore AI 核心层：凭证加解密、供应商目录、模型解析与 OpenAI 兼容调用。
package aicore

import (
	"os"
	"strings"

	"petrichor/api/internal/crypto"
)

// 默认加密参数与 TS config-logic.ts 保持一致（仅用于未配置环境变量时的回退）。
const (
	defaultEncryptKey  = "Ek4EhsOIVMQZ2gMAuJXJzUPjCZOjyKIt"
	defaultEncryptSalt = "57da7a247bba15d0"
)

func encryptSettings() (string, string) {
	key := firstEnv("PETRICHOR_ENCRYPT_KEY", "AI_CONFIG_ENCRYPT_KEY", defaultEncryptKey)
	salt := firstEnv("PETRICHOR_ENCRYPT_SALT", "AI_CONFIG_ENCRYPT_SALT", defaultEncryptSalt)
	return key, salt
}

func firstEnv(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return names[len(names)-1]
}

// EncodeApiKey 加密 API Key。
func EncodeApiKey(plain string) (string, error) {
	k, s := encryptSettings()
	return crypto.EncryptText(k, s, plain)
}

// DecodeApiKey 解密 API Key；空串返回空串。
func DecodeApiKey(encoded string) string {
	if strings.TrimSpace(encoded) == "" {
		return ""
	}
	k, s := encryptSettings()
	plain, err := crypto.DecryptText(k, s, encoded)
	if err != nil {
		return ""
	}
	return plain
}

// EncodeExtra 额外字段整体 JSON 后加密；空 map 返回 null 语义（空串）。
func EncodeExtra(extra map[string]string) (string, error) {
	entries := map[string]string{}
	for k, v := range extra {
		if strings.TrimSpace(v) != "" {
			entries[k] = v
		}
	}
	if len(entries) == 0 {
		return "", nil
	}
	return EncodeApiKey(jsonStringify(entries))
}

// DecodeExtra 解密额外字段 JSON。
func DecodeExtra(encoded string) map[string]string {
	raw := DecodeApiKey(encoded)
	if raw == "" {
		return map[string]string{}
	}
	out := map[string]string{}
	if err := jsonParse(raw, &out); err != nil {
		return map[string]string{}
	}
	return out
}

// MaskApiKey 掩码展示。
func MaskApiKey(apiKey string) any {
	value := strings.TrimSpace(apiKey)
	if value == "" {
		return nil
	}
	if len(value) <= 8 {
		return "********"
	}
	return value[:4] + "********" + value[len(value)-4:]
}
