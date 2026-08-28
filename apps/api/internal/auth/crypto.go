package auth

import (
	"crypto/sha256"
	"encoding/hex"
)

// HashAgentApiKey 使用 SHA-256 保存 Agent API Key 摘要。
func HashAgentApiKey(apiKey string) string {
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])
}
