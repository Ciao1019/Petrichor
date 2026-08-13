package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"strings"
)

const (
	pbkdf2Iterations  = 1024
	aesKeyLengthBytes = 32
	aesBlockSizeBytes = 16
)

// EncryptText 兼容现有 Spring AES-256-CBC（PBKDF2-HMAC-SHA1）密文格式。
func EncryptText(key, saltHex, plainText string) (string, error) {
	secretKey, err := deriveAESKey(key, saltHex)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secretKey)
	if err != nil {
		return "", err
	}
	iv := make([]byte, aesBlockSizeBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	padded := pkcs7Pad([]byte(plainText), aesBlockSizeBytes)
	encrypted := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(encrypted, padded)
	return hex.EncodeToString(append(iv, encrypted...)), nil
}

// DecryptText 解密库内 api_key_enc 等字段。
func DecryptText(key, saltHex, cipherHex string) (string, error) {
	secretKey, err := deriveAESKey(key, saltHex)
	if err != nil {
		return "", err
	}
	if cipherHex == "" || !isHex(cipherHex) {
		return "", fmt.Errorf("密文 hex 解码失败")
	}
	raw, err := hex.DecodeString(cipherHex)
	if err != nil {
		return "", fmt.Errorf("密文 hex 解码失败")
	}
	if len(raw) < aesBlockSizeBytes*2 || len(raw)%aesBlockSizeBytes != 0 {
		return "", fmt.Errorf("密文长度非法")
	}
	iv := raw[:aesBlockSizeBytes]
	payload := raw[aesBlockSizeBytes:]
	block, err := aes.NewCipher(secretKey)
	if err != nil {
		return "", err
	}
	decrypted := make([]byte, len(payload))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(decrypted, payload)
	plain, err := pkcs7Unpad(decrypted, aesBlockSizeBytes)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func deriveAESKey(key, saltHex string) ([]byte, error) {
	if strings.TrimSpace(key) == "" {
		return nil, fmt.Errorf("encrypt-key 不能为空")
	}
	if strings.TrimSpace(saltHex) == "" {
		return nil, fmt.Errorf("encrypt-salt 不能为空")
	}
	if len(saltHex)%2 != 0 {
		return nil, fmt.Errorf("encrypt-salt 必须为偶数长度的 hex 字符串")
	}
	if !isHex(saltHex) {
		return nil, fmt.Errorf("encrypt-salt 必须为合法的 hex 字符串")
	}
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return nil, fmt.Errorf("encrypt-salt 必须为合法的 hex 字符串")
	}
	return pbkdf2.Key(sha1.New, key, salt, pbkdf2Iterations, aesKeyLengthBytes)
}

func isHex(s string) bool {
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, fmt.Errorf("密文填充非法")
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > blockSize || pad > len(data) {
		return nil, fmt.Errorf("密文填充非法")
	}
	for i := len(data) - pad; i < len(data); i++ {
		if data[i] != byte(pad) {
			return nil, fmt.Errorf("密文填充非法")
		}
	}
	return data[:len(data)-pad], nil
}
