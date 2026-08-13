package assistant

import (
	"strings"
	"testing"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/crypto"
)

func TestAssistantAIConfigDTOAllowsEarlyPlaintextValue(t *testing.T) {
	plain := "sk-legacy-plain"
	row := assistantTestAIConfig(&plain)

	dto, err := assistantAIConfigDTO(row, nil)
	if err != nil {
		t.Fatalf("assistantAIConfigDTO() error = %v", err)
	}
	if dto["hasApiKey"] != true || dto["apiKeyMasked"] != "sk-l********lain" {
		t.Fatalf("unexpected key fields: hasApiKey=%v apiKeyMasked=%v", dto["hasApiKey"], dto["apiKeyMasked"])
	}
}

func TestAssistantAIConfigDTODecryptsCiphertext(t *testing.T) {
	cfg := &config.Config{EncryptKey: "assistant-test-key", EncryptSalt: "0011223344556677"}
	ciphertext, err := crypto.EncryptText(cfg.EncryptKey, cfg.EncryptSalt, "sk-secret-value")
	if err != nil {
		t.Fatalf("EncryptText() error = %v", err)
	}
	row := assistantTestAIConfig(&ciphertext)

	dto, err := assistantAIConfigDTO(row, cfg)
	if err != nil {
		t.Fatalf("assistantAIConfigDTO() error = %v", err)
	}
	if dto["apiKeyMasked"] != "sk-s********alue" {
		t.Fatalf("apiKeyMasked = %v", dto["apiKeyMasked"])
	}
}

func TestAssistantAIConfigDTORejectsUndecryptableCiphertext(t *testing.T) {
	ciphertext := strings.Repeat("ab", 32)
	row := assistantTestAIConfig(&ciphertext)

	if _, err := assistantAIConfigDTO(row, &config.Config{EncryptKey: "wrong", EncryptSalt: "0011223344556677"}); err == nil {
		t.Fatal("assistantAIConfigDTO() should reject undecryptable ciphertext")
	}
}

func assistantTestAIConfig(apiKeyEnc *string) *ent.AIModelConfig {
	baseURL := "https://example.com/v1"
	extraJSON := `{}`
	now := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	return &ent.AIModelConfig{
		ID: 1, ConfigType: "CHAT", Protocol: "OPENAI_COMPAT", Name: "test",
		BaseURL: &baseURL, APIKeyEnc: apiKeyEnc, Model: "test-model", Enabled: true,
		IsDefault: true, ExtraJSON: &extraJSON, CreatedAt: now, UpdatedAt: now,
	}
}
