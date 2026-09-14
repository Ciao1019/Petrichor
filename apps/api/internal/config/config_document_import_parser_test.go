package config

import (
	"testing"
	"time"
)

func TestDocumentImportParserConfig(t *testing.T) {
	path := writeTestConfig(t, `[database]
url = "postgres://localhost/test_unused"
[document_import.parser]
command = "/opt/bin/custom-convert"
timeout_seconds = 42
`)
	cfg, err := LoadFile(path)
	if err != nil || cfg.DocumentImport.Parser.Command != "/opt/bin/custom-convert" || cfg.DocumentImport.Parser.Timeout != 42*time.Second {
		t.Fatalf("解析配置未接线: %v", err)
	}
	for _, seconds := range []int{-1, 1801} {
		raw := documentImportFileConfig{}
		raw.Parser.TimeoutSeconds = seconds
		if _, err := normalizeDocumentImport(raw); err == nil {
			t.Fatal("未拒绝超限 timeout", seconds)
		}
	}
	raw := documentImportFileConfig{}
	raw.Parser.Command = "bad\ncommand"
	if _, err := normalizeDocumentImport(raw); err == nil {
		t.Fatal("未拒绝非法命令")
	}
}
