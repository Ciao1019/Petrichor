package crypto

import "testing"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := "test-encrypt-key-please-change"
	salt := "0123456789abcdef"
	plain := "sk-test-secret-key"
	cipherHex, err := EncryptText(key, salt, plain)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecryptText(key, salt, cipherHex)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("got %q want %q", got, plain)
	}
}
