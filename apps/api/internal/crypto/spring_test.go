package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"testing"
)

const (
	testKey  = "test-encryption-key-with-at-least-32-characters"
	testSalt = "9e86d78a95084fca9be48739837d91b6"
)

func TestEncryptTextUsesAuthenticatedV2Envelope(t *testing.T) {
	encoded, err := EncryptText(testKey, testSalt, "sk-secret")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encoded, ciphertextV2) {
		t.Fatalf("expected v2 prefix, got %q", encoded)
	}
	plain, err := DecryptText(testKey, testSalt, encoded)
	if err != nil || plain != "sk-secret" {
		t.Fatalf("roundtrip = %q, %v", plain, err)
	}
}

func TestDecryptTextRejectsTamperedV2Ciphertext(t *testing.T) {
	encoded, err := EncryptText(testKey, testSalt, "sk-secret")
	if err != nil {
		t.Fatal(err)
	}
	last := encoded[len(encoded)-1]
	replacement := byte('A')
	if last == replacement {
		replacement = 'B'
	}
	tampered := encoded[:len(encoded)-1] + string(replacement)
	if _, err := DecryptText(testKey, testSalt, tampered); err == nil {
		t.Fatal("expected authenticated decryption failure")
	}
}

func TestDecryptTextReadsLegacyCiphertext(t *testing.T) {
	legacy, err := encryptLegacyForTest(testKey, testSalt, "legacy-secret")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := DecryptText(testKey, testSalt, legacy)
	if err != nil || plain != "legacy-secret" {
		t.Fatalf("legacy decrypt = %q, %v", plain, err)
	}
}

func encryptLegacyForTest(key, saltHex, plainText string) (string, error) {
	secretKey, err := deriveLegacyKey(key, saltHex)
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
	for index := len(plain); index < len(padded); index++ {
		padded[index] = byte(padding)
	}
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return hex.EncodeToString(append(iv, out...)), nil
}
