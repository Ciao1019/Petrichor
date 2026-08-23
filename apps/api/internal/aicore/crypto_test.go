package aicore_test

import (
	"testing"

	"petrichor/api/internal/aicore"
)

// 与 Node spring-text-encryptor 的互操作基准：
// encryptText(key, salt, plain) 输出 hex(iv+ciphertext)，PBKDF2-SHA1/1024/AES-256-CBC。
func TestApiKeyCryptoRoundTrip(t *testing.T) {
	plain := "sk-test-1234567890abcdef"
	enc, err := aicore.EncodeApiKey(plain)
	if err != nil {
		t.Fatal(err)
	}
	if dec := aicore.DecodeApiKey(enc); dec != plain {
		t.Fatalf("解密不匹配: %s", dec)
	}
}

func TestDecodeInvalidHex(t *testing.T) {
	if got := aicore.DecodeApiKey("zzzz-not-hex"); got != "" {
		t.Fatalf("非法密文应返回空串: %s", got)
	}
}

func TestMaskApiKey(t *testing.T) {
	if aicore.MaskApiKey("") != nil {
		t.Fatal("空 key 应为 null")
	}
	if aicore.MaskApiKey("short") != "********" {
		t.Fatal("短 key 应全掩码")
	}
	masked, _ := aicore.MaskApiKey("sk-abcdefghijklmnop").(string)
	if masked != "sk-a********mnop" {
		t.Fatalf("掩码格式不符: %s", masked)
	}
}
