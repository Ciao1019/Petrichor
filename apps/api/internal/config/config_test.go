package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

[cache.redis]
url = "redis://redis:6379/2"
pool_size = 48
min_idle_conns = 6
read_timeout_ms = 750

[knowledge_build]
concurrency = 8
queue_size = 256
question_batch_concurrency = 10
page_batch_concurrency = 12
model_concurrency = 96

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
	if cfg.Redis == nil || cfg.Redis.URL != "redis://redis:6379/2" || cfg.Redis.PoolSize != 48 || cfg.Redis.MinIdleConns != 6 {
		t.Fatalf("redis config = %+v", cfg.Redis)
	}
	if cfg.Redis.ReadTimeout != 750*time.Millisecond {
		t.Fatalf("redis read timeout = %s", cfg.Redis.ReadTimeout)
	}
	if cfg.KnowledgeBuild != (KnowledgeBuildConfig{
		Concurrency: 8, QueueSize: 256, QuestionBatchConcurrency: 10, PageBatchConcurrency: 12,
		ModelConcurrency: 96,
	}) {
		t.Fatalf("knowledge build config = %+v", cfg.KnowledgeBuild)
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

func TestLoadFileRejectsInvalidRedisConfig(t *testing.T) {
	tests := []struct {
		name   string
		config string
		want   string
	}{
		{name: "invalid URL", config: `url = "https://redis.example.com"`, want: "redis:// 或 rediss://"},
		{name: "idle pool too large", config: `url = "redis://redis:6379/0"
pool_size = 2
min_idle_conns = 3`, want: "min_idle_conns <= pool_size"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writeTestConfig(t, `[database]
url = "postgres://localhost/petrichor"

[cache.redis]
`+tt.config)
			_, err := LoadFile(path)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %q error, got %v", tt.want, err)
			}
		})
	}
}

func TestLoadFileUsesKnowledgeBuildDefaults(t *testing.T) {
	path := writeTestConfig(t, `[database]
url = "postgres://localhost/petrichor"`)
	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile() error = %v", err)
	}
	want := KnowledgeBuildConfig{
		Concurrency:              DefaultKnowledgeBuildConcurrency,
		QueueSize:                DefaultKnowledgeBuildQueueSize,
		QuestionBatchConcurrency: DefaultKnowledgeBuildQuestionBatchConcurrency,
		PageBatchConcurrency:     DefaultKnowledgeBuildPageBatchConcurrency,
		ModelConcurrency:         DefaultKnowledgeBuildModelConcurrency,
	}
	if cfg.KnowledgeBuild != want {
		t.Fatalf("knowledge build defaults = %+v, want %+v", cfg.KnowledgeBuild, want)
	}
}

func TestLoadFileRejectsUnsafeKnowledgeBuildConcurrency(t *testing.T) {
	tests := []struct {
		name   string
		config string
		want   string
	}{
		{name: "article concurrency", config: "concurrency = 33", want: "concurrency 必须在 1 到 32"},
		{name: "queue limit", config: "queue_size = 4097", want: "queue_size 必须在 1 到 4096"},
		{name: "model concurrency", config: "model_concurrency = 129", want: "model_concurrency 必须在 1 到 128"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := writeTestConfig(t, `[database]
url = "postgres://localhost/petrichor"

[knowledge_build]
`+test.config)
			_, err := LoadFile(path)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q error, got %v", test.want, err)
			}
		})
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
