package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFileParsesTomlConfig(t *testing.T) {
	path := writeTestConfig(t, `
[server]
environment = "development"
port = 9090
base_url = "http://localhost:3000/"

[database]
url = "postgres://localhost/petrichor"

[auth]
register_enabled = true
default_system_role = "super_admin"

[auth.local_development]
enabled = true
user_id = 7

[storage.s3]
endpoint = "s3.example.com"
access_key_id = "access"
secret_access_key = "secret"
bucket = "bucket"
use_ssl = false

[cache.upstash]
rest_url = "https://redis.example.com/"
rest_token = "token"

[agent.features]
debug = true

[agent.budget.multi_step]
max_iterations = 16
max_tool_calls = 20
max_subagents = 3

[agent.research]
provider = "searxng"
base_url = "https://search.example.com/"
timeout_ms = 9000
`)

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile() error = %v", err)
	}
	if cfg.APIPort != "9090" || cfg.BaseURL != "http://localhost:3000" {
		t.Fatalf("server config = port %s, base URL %s", cfg.APIPort, cfg.BaseURL)
	}
	if !cfg.RegisterEnabled || cfg.RegisterDefaultRole != "SUPER_ADMIN" {
		t.Fatalf("auth config = enabled %v, role %s", cfg.RegisterEnabled, cfg.RegisterDefaultRole)
	}
	if !cfg.LocalDevelopmentAuth.Enabled || cfg.LocalDevelopmentAuth.UserID != 7 {
		t.Fatalf("local auth config = %+v", cfg.LocalDevelopmentAuth)
	}
	if cfg.S3 == nil || cfg.S3.Endpoint != "http://s3.example.com" || cfg.S3.UseSSL {
		t.Fatalf("s3 config = %+v", cfg.S3)
	}
	if cfg.Upstash == nil || cfg.Upstash.RESTURL != "https://redis.example.com" {
		t.Fatalf("upstash config = %+v", cfg.Upstash)
	}
	if !cfg.Agent.Features.SoftRouter || !cfg.Agent.Features.Debug {
		t.Fatalf("agent features = %+v", cfg.Agent.Features)
	}
	if got := cfg.Agent.Budget.MultiStep.MaxIterations; got != 16 {
		t.Fatalf("multi-step max iterations = %d", got)
	}
	if cfg.Agent.Research.Provider != "searxng" || cfg.Agent.Research.BaseURL != "https://search.example.com" || cfg.Agent.Research.TimeoutMs != 9000 {
		t.Fatalf("agent research config = %+v", cfg.Agent.Research)
	}
}

func TestLoadFileRejectsUnknownFields(t *testing.T) {
	path := writeTestConfig(t, `
[server]
unknown = true

[database]
url = "postgres://localhost/petrichor"

`)

	_, err := LoadFile(path)
	if err == nil || !strings.Contains(err.Error(), "strict mode") {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestLoadFileRejectsLocalBypassInProduction(t *testing.T) {
	path := writeTestConfig(t, `
[server]
environment = "production"

[database]
url = "postgres://localhost/petrichor"

[auth.local_development]
enabled = true
user_id = 1
`)

	_, err := LoadFile(path)
	if err == nil || !strings.Contains(err.Error(), "只能在 development") {
		t.Fatalf("expected production local auth error, got %v", err)
	}
}

func TestLoadFileRejectsPoolTooSmallForWorkers(t *testing.T) {
	path := writeTestConfig(t, `
[database]
url = "postgres://localhost/petrichor"
max_conns = 4
`)

	_, err := LoadFile(path)
	if err == nil || !strings.Contains(err.Error(), "max_conns >= 6") {
		t.Fatalf("expected pool size error, got %v", err)
	}
}

func TestLoadFileRejectsDefaultEncryptionInProduction(t *testing.T) {
	path := writeTestConfig(t, `
[server]
environment = "production"

[database]
url = "postgres://localhost/petrichor"

[encryption]
key = "replace-with-a-stable-random-secret-of-at-least-32-chars"
salt = "00000000000000000000000000000000"
`)

	_, err := LoadFile(path)
	if err == nil || !strings.Contains(err.Error(), "禁止使用默认或示例") {
		t.Fatalf("expected production encryption error, got %v", err)
	}
}

func TestLoadFileAcceptsStrongProductionEncryption(t *testing.T) {
	path := writeTestConfig(t, `
[server]
environment = "production"

[database]
url = "postgres://localhost/petrichor"

[encryption]
key = "r4ndom-production-key-with-more-than-32-characters"
salt = "9e86d78a95084fca9be48739837d91b6"
`)

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile() error = %v", err)
	}
	if cfg.Encryption.Salt != "9e86d78a95084fca9be48739837d91b6" {
		t.Fatalf("unexpected encryption config: %+v", cfg.Encryption)
	}
}

func writeTestConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(strings.TrimSpace(content)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
