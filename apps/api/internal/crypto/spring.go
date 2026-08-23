// Package crypto 复刻 src/server/crypto/spring-text-encryptor.ts：
// PBKDF2-SHA1(1024) 派生 AES-256-CBC key，输出 hex(iv+ciphertext)。
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	pbkdf2Iterations = 1024
	aesKeyLen        = 32
	aesBlockSize     = 16
)

func deriveKey(key, saltHex string) ([]byte, error) {
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
	return pbkdf2.Key(sha1.New, key, saltBytes, pbkdf2Iterations, aesKeyLen)
}

// EncryptText 加密明文。
func EncryptText(key, saltHex, plainText string) (string, error) {
	secretKey, err := deriveKey(key, saltHex)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secretKey)
	if err != nil {
		return "", err
	}
	iv := make([]byte, aesBlockSize)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	plain := []byte(plainText)
	padding := aesBlockSize - len(plain)%aesBlockSize
	padded := make([]byte, len(plain)+padding)
	copy(padded, plain)
	for i := len(plain); i < len(padded); i++ {
		padded[i] = byte(padding) // PKCS7，与 node crypto 默认一致
	}
	mode := cipher.NewCBCEncrypter(block, iv)
	out := make([]byte, len(padded))
	mode.CryptBlocks(out, padded)
	return hex.EncodeToString(append(iv, out...)), nil
}

// DecryptText 解密密文。
func DecryptText(key, saltHex, cipherHex string) (string, error) {
	secretKey, err := deriveKey(key, saltHex)
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
