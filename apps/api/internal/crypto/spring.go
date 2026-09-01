// Package crypto 提供带版本的凭证加密。新密文使用 HKDF-SHA256 + AES-256-GCM；
// 解密时仍兼容历史 Spring PBKDF2-SHA1 + AES-CBC 密文，便于滚动迁移。
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	pbkdf2Iterations = 1024
	aesKeyLen        = 32
	aesBlockSize     = 16
	ciphertextV2     = "v2:"
)

var credentialAssociatedData = []byte("petrichor:credential:v2")

func decodeSalt(key, saltHex string) ([]byte, error) {
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("encrypt-key 不能为空")
	}
	salt := strings.TrimSpace(saltHex)
	if salt == "" {
		return nil, errors.New("encrypt-salt 不能为空")
	}
	if len(salt)%2 != 0 {
		return nil, errors.New("encrypt-salt 必须为偶数长度的 hex 字符串")
	}
	saltBytes, err := hex.DecodeString(salt)
	if err != nil {
		return nil, errors.New("encrypt-salt 必须为合法的 hex 字符串")
	}
	return saltBytes, nil
}

func deriveKey(key, saltHex string) ([]byte, error) {
	salt, err := decodeSalt(key, saltHex)
	if err != nil {
		return nil, err
	}
	derived, err := hkdf.Key(sha256.New, []byte(key), salt, string(credentialAssociatedData), aesKeyLen)
	if err != nil {
		return nil, fmt.Errorf("派生凭证密钥失败: %w", err)
	}
	return derived, nil
}

func deriveLegacyKey(key, saltHex string) ([]byte, error) {
	saltBytes, err := decodeSalt(key, saltHex)
	if err != nil {
		return nil, err
	}
	return pbkdf2.Key(sha1.New, key, saltBytes, pbkdf2Iterations, aesKeyLen)
}

// EncryptText 使用 AES-256-GCM 加密并返回带版本前缀的 base64url 密文。
func EncryptText(key, saltHex, plainText string) (string, error) {
	secretKey, err := deriveKey(key, saltHex)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secretKey)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, nonce, []byte(plainText), credentialAssociatedData)
	payload := append(nonce, sealed...)
	return ciphertextV2 + base64.RawURLEncoding.EncodeToString(payload), nil
}

// DecryptText 自动识别 v2 AEAD 密文；无版本前缀时按历史 AES-CBC 格式读取。
func DecryptText(key, saltHex, encoded string) (string, error) {
	if strings.HasPrefix(encoded, ciphertextV2) {
		return decryptV2(key, saltHex, strings.TrimPrefix(encoded, ciphertextV2))
	}
	return decryptLegacy(key, saltHex, encoded)
}

func decryptV2(key, saltHex, payloadBase64 string) (string, error) {
	secretKey, err := deriveKey(key, saltHex)
	if err != nil {
		return "", err
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadBase64)
	if err != nil {
		return "", fmt.Errorf("v2 密文 base64url 解码失败")
	}
	block, err := aes.NewCipher(secretKey)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < aead.NonceSize()+aead.Overhead() {
		return "", fmt.Errorf("v2 密文长度非法")
	}
	nonce, ciphertext := payload[:aead.NonceSize()], payload[aead.NonceSize():]
	plain, err := aead.Open(nil, nonce, ciphertext, credentialAssociatedData)
	if err != nil {
		return "", fmt.Errorf("v2 密文完整性校验失败")
	}
	return string(plain), nil
}

func decryptLegacy(key, saltHex, cipherHex string) (string, error) {
	secretKey, err := deriveLegacyKey(key, saltHex)
	if err != nil {
		return "", err
	}
	raw, err := hex.DecodeString(cipherHex)
	if err != nil {
		return "", fmt.Errorf("密文 hex 解码失败")
	}
	if len(raw) < aesBlockSize*2 || len(raw)%aesBlockSize != 0 {
		return "", fmt.Errorf("密文长度非法")
	}
	block, err := aes.NewCipher(secretKey)
	if err != nil {
		return "", err
	}
	iv := raw[:aesBlockSize]
	payload := raw[aesBlockSize:]
	mode := cipher.NewCBCDecrypter(block, iv)
	out := make([]byte, len(payload))
	mode.CryptBlocks(out, payload)
	pad := int(out[len(out)-1])
	if pad <= 0 || pad > aesBlockSize || pad > len(out) {
		return "", fmt.Errorf("解密失败：填充非法")
	}
	for _, b := range out[len(out)-pad:] {
		if int(b) != pad {
			return "", fmt.Errorf("解密失败：填充非法")
		}
	}
	return string(out[:len(out)-pad]), nil
}
